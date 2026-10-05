// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { RegionalstatistikNetworkError } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Timeout for the whole request, response body included, in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
  /**
   * Aborted when the engine's overall deadline (`timeoutMs`) passes. A transport should
   * stop the request then (`fetch(url, { signal })`); the engine rejects at the deadline
   * either way, and enforces `maxResponseBytes` on the body it gets back, so neither
   * limit depends on the transport.
   */
  signal?: AbortSignal;
}

/**
 * What a transport resolves with. The engine is lenient about what a custom transport
 * hands back: `headers` may also be a `Headers` object or a `Map`, with names in any
 * case, and `body` any `ArrayBuffer` view (fetch's `Uint8Array`) or an `ArrayBuffer`.
 * Anything else — no status, a status outside 100–599, no headers, a string body — is
 * a `RegionalstatistikNetworkError`.
 */
export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The message for a body over the size cap, naming the option on both sides. */
export function sizeLimitMessage(maxBytes: number): string {
  return `Response exceeded the size limit of ${maxBytes} bytes (maxResponseBytes; --max-response-bytes on the CLI)`;
}

/** The message for a request that ran past `timeoutMs`. */
export function timeoutMessage(timeoutMs: number): string {
  return `Request timed out after ${timeoutMs}ms`;
}

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs).
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new RegionalstatistikNetworkError(`Invalid URL: ${request.url}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(
        new RegionalstatistikNetworkError(`Unsupported protocol "${url.protocol}" in URL: ${request.url}`),
      );
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    // The timeout covers the whole exchange — connecting, waiting and reading the body.
    // A socket idle timeout alone would let a server that trickles a byte now and then
    // hold the request open indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = <T>(fn: (value: T) => void) => (value: T) => {
      clearTimeout(timer);
      fn(value);
    };
    const done = settle(resolve);
    const fail = settle(reject);

    // driver.request throws synchronously for a header value Node cannot send (CR/LF,
    // a character above U+00FF — e.g. in a credential or the User-Agent); surface
    // that as a typed error, not a raw TypeError.
    let req: http.ClientRequest;
    try {
      req = driver.request(
        url,
        {
          method: request.method,
          headers: request.headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          let aborted = false;

          res.on("data", (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (maxBytes !== undefined && received > maxBytes) {
              aborted = true;
              res.destroy();
              fail(new RegionalstatistikNetworkError(sizeLimitMessage(maxBytes)));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (aborted) return;
            done({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
          res.on("error", (err) => {
            if (aborted) return; // we already rejected with the size-cap error
            fail(new RegionalstatistikNetworkError(`Response stream error: ${err.message}`, { cause: err }));
          });
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reject(new RegionalstatistikNetworkError(`Invalid request: ${message}`, { cause: err }));
      return;
    }

    if (request.timeoutMs && request.timeoutMs > 0) {
      const timeoutMs = request.timeoutMs;
      timer = setTimeout(() => {
        const err = new RegionalstatistikNetworkError(timeoutMessage(timeoutMs));
        fail(err);
        req.destroy(err);
      }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    }

    if (request.signal !== undefined) {
      const signal = request.signal;
      const abort = (): void => {
        const reason: unknown = signal.reason;
        const err =
          reason instanceof RegionalstatistikNetworkError ? reason : new RegionalstatistikNetworkError(timeoutMessage(request.timeoutMs ?? 0));
        fail(err);
        req.destroy(err);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    req.on("error", (err) => {
      // A timeout destroy already passes a RegionalstatistikNetworkError; don't double-wrap.
      fail(
        err instanceof RegionalstatistikNetworkError
          ? err
          : new RegionalstatistikNetworkError(err.message, { cause: err }),
      );
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
