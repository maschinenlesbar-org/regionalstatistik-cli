// The request engine: turns logical (path, params) calls into HTTP requests via a
// Transport, applies retry/backoff for transient statuses (429, 503), decodes
// responses, and — crucially for GENESIS — inspects the `Status` object in a
// *successful* (HTTP 200) body to surface logical errors.
//
// Transport shape (verified against the live regionalstatistik.de 2020 endpoint,
// 2026-07-13): authenticated calls are **POST** with an
// `application/x-www-form-urlencoded` body carrying the parameters, and
// credentials in HTTP **header** fields (`username`, and `password` when not
// using a token). A GET to an authenticated endpoint answers HTTP 405. Only
// `helloworld/whoami` is an unauthenticated GET.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { RegionalstatistikApiError, RegionalstatistikParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://www.regionalstatistik.de";
const DEFAULT_USER_AGENT = "regionalstatistik-cli";
// The charset is REQUIRED: without it GENESIS decodes the body as Latin-1, so a
// UTF-8 umlaut (e.g. "Bevölkerung") arrives mojibaked and matches nothing.
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=UTF-8";

// GENESIS logical `Status.Code` values this engine acts on. All others (0 ok,
// 22 ok-with-auto-correction, 50 no-newer-data, ...) are returned as-is so the
// caller sees the full envelope (Status.Content carries any warning text).
const CODE_NOT_FOUND = 90; // requested object does not exist
const CODE_TOO_LARGE = 98; // result too large for a synchronous fetch (needs the async job flow)
const CODE_EMPTY = 104; // no object matched the selection/search — a valid *empty* result

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://www.regionalstatistik.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; capped at `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strip terminal control characters from a server-controlled string before it
 * can reach stdout/stderr. A hostile or MITM'd endpoint can embed ANSI escape
 * sequences (or other C0/C1 controls) in `Status.Content`, a plain-text error
 * body, or the `Content-Type` header to spoof terminal output or abuse terminal
 * features. We drop C0 (0x00..0x08, 0x0B..0x1F), DEL (0x7F) and C1 (0x80..0x9F);
 * tab (0x09), newline (0x0A) and carriage return (0x0D) are kept so multi-line
 * messages survive. Implemented as a code-point filter so this source file never
 * contains a raw control byte.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n === 0x09 || n === 0x0a || n === 0x0d) {
      out += ch;
      continue;
    }
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * Mask credentials in a URL before it appears in an error message. Defensive:
 * this client sends credentials in headers (not the query string), but a caller
 * who overrides the transport or base URL could still put them in the URL, so
 * any URL surfaced in an error is scrubbed. Two channels are masked:
 *  - the `username` / `password` **query parameters** (legacy GENESIS style), and
 *  - the URL **userinfo** component (`https://user:pass@host`), which Node turns
 *    into a Basic `Authorization` header — otherwise `user:pass@` would leak
 *    verbatim into stderr / CI logs on any error.
 */
export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    for (const key of ["username", "password"]) {
      if (u.searchParams.has(key)) u.searchParams.set(key, "***");
    }
    // Strip any embedded userinfo so a credentialed base URL is not logged.
    if (u.username) u.username = "***";
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path (parameters travel in the body). */
  buildUrl(path: string): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${normalizedPath}`;
  }

  /**
   * Perform a request with Accept negotiation and transient-error retries. POST
   * requests carry `params` as a form-urlencoded body; GET requests take none.
   *
   * Redirects are deliberately NOT followed: the canonical host
   * (www.regionalstatistik.de) answers directly, and following a cross-origin
   * redirect would forward credential headers to another origin. A 3xx therefore
   * surfaces as an error, with a hint to use the canonical host.
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    options: { params?: QueryParams; accept: string; authHeaders?: Record<string, string> },
  ): Promise<RawResponse> {
    const url = this.buildUrl(path);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
      ...this.defaultHeaders,
      ...(options.authHeaders ?? {}),
    };

    let body: Buffer | undefined;
    if (method === "POST") {
      body = Buffer.from(buildQueryString(options.params ?? {}), "utf8");
      headers["Content-Type"] = FORM_CONTENT_TYPE;
      // Always set Content-Length (even 0) — GENESIS answers 411 to a POST
      // without one.
      headers["Content-Length"] = String(body.length);
    }

    let attempt = 0;
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      // Sanitize the server-controlled Content-Type at the source: it is echoed
      // to stderr by renderRaw, so strip any embedded terminal control chars.
      const contentType = sanitizeServerText(String(response.headers["content-type"] ?? ""));
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** GET a JSON body without credentials (helloworld/whoami). */
  async getJson<T>(path: string): Promise<T> {
    const res = await this.request("GET", path, { accept: "application/json" });
    return this.decodeJson<T>("GET", path, res);
  }

  /** POST form-encoded params (with credential headers) and parse the JSON reply. */
  async postJson<T>(
    path: string,
    params: QueryParams,
    authHeaders: Record<string, string>,
  ): Promise<T> {
    const res = await this.request("POST", path, { params, accept: "application/json", authHeaders });
    return this.decodeJson<T>("POST", path, res);
  }

  /**
   * POST form-encoded params and return the raw bytes (file / binary downloads).
   * If the server answered with JSON instead of the expected binary (e.g. a
   * credential or "too large" error on a `data/*file` endpoint), the logical
   * `Status` is checked so the failure surfaces cleanly.
   */
  async postRaw(
    path: string,
    accept: string,
    params: QueryParams,
    authHeaders: Record<string, string>,
  ): Promise<RawResponse> {
    const res = await this.request("POST", path, { params, accept, authHeaders });
    if (/json/i.test(res.contentType)) {
      const text = res.data.toString("utf8");
      try {
        const parsed = JSON.parse(text) as unknown;
        this.checkLogicalStatus("POST", this.buildUrl(path), text, parsed);
      } catch (err) {
        if (err instanceof RegionalstatistikApiError) throw err;
        // Not parseable / not an envelope — fall through and return the bytes.
      }
    }
    return res;
  }

  private decodeJson<T>(method: "GET" | "POST", path: string, res: RawResponse): T {
    const text = res.data.toString("utf8");
    if (res.status === 204 || text.trim().length === 0) {
      return null as T;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new RegionalstatistikParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
    this.checkLogicalStatus(method, this.buildUrl(path), text, parsed);
    return parsed as T;
  }

  /**
   * Inspect a parsed GENESIS body for a logical error. GENESIS answers HTTP 200
   * even when a request logically failed. The outcome arrives in one of TWO
   * shapes (both verified live on regionalstatistik.de):
   *
   *  - the usual envelope with a `Status` object (`{ Code, Content, Type }`), or
   *  - a **flat** top-level `{ Code, Content, Type }` object with no envelope at
   *    all — the authentication-failure shape (Code 15 when no credentials were
   *    sent, Code 2 for wrong credentials). The live server pairs those with
   *    HTTP 401/404 (handled in toApiError); the flat mapping here is kept as a
   *    defensive path should they ever arrive on a 2xx.
   *
   * Throws for "object not found" (90), "too large" (98), and any error `Type`
   * (which covers the flat auth errors); returns quietly for success/warning
   * codes and for the "empty result" code (104), which is a valid outcome the
   * caller renders as an empty list.
   */
  private checkLogicalStatus(
    method: "GET" | "POST",
    url: string,
    body: string,
    parsed: unknown,
  ): void {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const top = parsed as { Status?: unknown; Code?: unknown; Content?: unknown; Type?: unknown };

    let s: { Code?: unknown; Content?: unknown; Type?: unknown };
    if (top.Status !== undefined) {
      // helloworld/logincheck put a plain string in `Status`; only the object
      // form carries a logical `Code` worth inspecting.
      if (!top.Status || typeof top.Status !== "object") return;
      s = top.Status as { Code?: unknown; Content?: unknown; Type?: unknown };
    } else if (typeof top.Code === "number" && typeof top.Type === "string") {
      // Flat (envelope-less) status object — the auth-failure shape.
      s = top;
    } else {
      return;
    }

    const code = typeof s.Code === "number" ? s.Code : undefined;
    if (code === undefined || code === CODE_EMPTY) return;

    // Type / Content are server-controlled and reach the terminal via the error
    // message; strip any embedded terminal control characters at the source.
    const type = typeof s.Type === "string" ? sanitizeServerText(s.Type) : undefined;
    const content = typeof s.Content === "string" ? sanitizeServerText(s.Content) : undefined;
    const isErrorType = type !== undefined && /error|fehler/i.test(type);

    if (code === CODE_NOT_FOUND || code === CODE_TOO_LARGE || isErrorType) {
      const detail =
        code === CODE_TOO_LARGE
          ? `${content ?? "result too large"} — this read-only CLI does not run the async batch-job flow; narrow the selection (--start-year/--end-year/--timeslices/--region-key/--class-key) or download a smaller subset`
          : content;
      throw new RegionalstatistikApiError({
        method,
        url: redactUrl(url),
        body,
        code,
        statusType: type,
        detail,
      });
    }
  }

  /**
   * Map a non-2xx reply to a typed error. The live server pairs auth failures
   * with a GENESIS status JSON body (HTTP 401 + flat `{ Code: 15, ... }` for
   * missing credentials, HTTP 404 + flat `{ Code: 2, ... }` for wrong ones), so
   * the body is inspected for a GENESIS status — enveloped or flat — and its
   * Code/Type/Content are carried onto the error. That keeps a 404-for-bad-
   * credentials from masquerading as "object not found" (see errors.ts).
   */
  private toApiError(
    method: "GET" | "POST",
    url: string,
    status: number,
    body: Buffer,
  ): RegionalstatistikApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    let code: number | undefined;
    let statusType: string | undefined;
    if (status >= 300 && status < 400) {
      detail = "unexpected redirect — use the canonical host (default https://www.regionalstatistik.de)";
    } else {
      try {
        const parsed = JSON.parse(text) as {
          Status?: { Code?: unknown; Content?: unknown; Type?: unknown } | string | null;
          Code?: unknown;
          Content?: unknown;
          Type?: unknown;
          detail?: unknown;
        };
        const s =
          parsed?.Status && typeof parsed.Status === "object"
            ? parsed.Status
            : typeof parsed?.Code === "number" && typeof parsed?.Type === "string"
              ? parsed
              : undefined;
        if (s) {
          if (typeof s.Code === "number") code = s.Code;
          if (typeof s.Type === "string") statusType = s.Type;
          if (typeof s.Content === "string") detail = s.Content;
        } else if (typeof parsed?.detail === "string") {
          detail = parsed.detail;
        }
      } catch {
        // Not JSON. Surface a short, whitespace-collapsed snippet of a textual
        // body so the failure isn't context-free. Skip HTML/XML error pages
        // (start with "<"), which are noise to a CLI user — regionalstatistik.de
        // serves a full HTML error page (with a leading BOM, hence the strip)
        // e.g. for a wrong (uppercase `/genesisWS`) API path. The `\s+` collapse
        // leaves ESC/C0 controls intact, so sanitize below.
        const snippet = text.replace(/^\uFEFF/, "").trim().replace(/\s+/g, " ");
        if (snippet.length > 0 && !snippet.startsWith("<")) {
          detail = snippet.length > 200 ? `${snippet.slice(0, 200)}…` : snippet;
        }
      }
      // All branches take server-controlled text; strip terminal control chars
      // before it reaches stderr.
      if (detail !== undefined) detail = sanitizeServerText(detail);
      if (statusType !== undefined) statusType = sanitizeServerText(statusType);
    }
    return new RegionalstatistikApiError({
      httpStatus: status,
      url: redactUrl(url),
      method,
      body: text,
      ...(code !== undefined ? { code } : {}),
      ...(statusType !== undefined ? { statusType } : {}),
      detail,
    });
  }
}
