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

import { MAX_TIMEOUT_MS, nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  RegionalstatistikApiError,
  RegionalstatistikError,
  RegionalstatistikParseError,
  credentialsIn,
  redactCredentials,
  redactSecrets,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem, intRangeProblem } from "./validate.js";

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
  /**
   * Base URL of the API. Defaults to https://www.regionalstatistik.de. Must be an
   * http(s) URL without userinfo, query, fragment or whitespace (`baseUrlProblem`);
   * the constructor throws RegionalstatistikValidationError otherwise.
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header (only `undefined` selects the default). Must be
   * a valid header value: non-blank, no control characters, nothing above U+00FF.
   */
  userAgent?: string;
  /** Extra headers sent on every request (token names, valid header values). */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: 0 to `MAX_TIMEOUT_MS` (2^31 - 1 ms); 0 disables.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, 0 to
   * `MAX_RETRIES`; defaults to 2. Each waits the response's `Retry-After` (up to
   * `MAX_RETRY_AFTER_MS`; a longer one is not retried), or else
   * `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly); used without a Retry-After. */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   *
   * Every numeric option must be a non-negative safe integer within its range;
   * the constructor throws RegionalstatistikValidationError otherwise (a negative
   * or NaN timeout or cap would silently switch that guard off).
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Most automatic retries the engine performs (`maxRetries`, the CLI's --max-retries). */
export const MAX_RETRIES = 10;

/** Check an optional numeric engine option against `[min, max]` (RegionalstatistikValidationError). */
function intOption(name: string, value: number | undefined, min: number, max: number): number | undefined {
  return value === undefined ? undefined : assertValid(name, value, intRangeProblem(min, max));
}

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

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
    // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no
    // userinfo, so cut the credentials out by text.
    if (!u.username && !u.password && credentialsIn(rawUrl).length > 0) {
      return redactCredentials(rawUrl, credentialsIn(rawUrl));
    }
    for (const key of ["username", "password"]) {
      if (u.searchParams.has(key)) u.searchParams.set(key, "***");
    }
    // Strip any embedded userinfo so a credentialed base URL is not logged.
    if (u.username) u.username = "***";
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    // A value that doesn't parse (a port typo, an unencoded "#" in the password) can
    // still carry credentials: cut them out by text.
    return redactCredentials(rawUrl, credentialsIn(rawUrl));
  }
}

/**
 * Whether a request carried credentials, for
 * `RegionalstatistikApiError.credentialsSent`: `undefined` for an endpoint that
 * takes none (whoami — no auth headers passed at all), `false` for an
 * authenticatable endpoint called without them, `true` when a `username` header
 * went out.
 */
function credentialsSent(authHeaders: Record<string, string> | undefined): boolean | undefined {
  return authHeaders === undefined ? undefined : Object.keys(authHeaders).length > 0;
}

/** What the error paths of one request need to know about its credentials. */
interface RequestContext {
  /** See `credentialsSent`. */
  sent: boolean | undefined;
  /** The credential values sent, in the forms an echo may take (raw, JSON- and URL-escaped). */
  secrets: readonly string[];
}

function contextOf(authHeaders: Record<string, string> | undefined): RequestContext {
  const secrets = new Set<string>();
  for (const value of Object.values(authHeaders ?? {})) {
    secrets.add(value);
    secrets.add(JSON.stringify(value).slice(1, -1));
    secrets.add(encodeURIComponent(value));
  }
  return { sent: credentialsSent(authHeaders), secrets: [...secrets] };
}

/**
 * `text` without the request's credentials: a server body or a transport message may
 * echo the token, username or password (`logincheck` returns the token as
 * `Username`), and that text ends up in an error's message, `detail` or `body`.
 */
function scrub(text: string, ctx: RequestContext): string {
  return ctx.secrets.length === 0 ? text : redactSecrets(text, ctx.secrets);
}

/**
 * A thrown value without the request's credentials: the original when its text carries
 * none, otherwise a copy with them scrubbed (message, name, `code` and the cause chain
 * kept), so logging an error with its causes can't reveal them.
 */
function scrubThrown(thrown: unknown, ctx: RequestContext, depth = 0): unknown {
  if (ctx.secrets.length === 0 || depth > 5) return thrown;
  if (typeof thrown === "string") return scrub(thrown, ctx);
  if (!(thrown instanceof Error)) return thrown;
  const inner = scrubThrown(thrown.cause, ctx, depth + 1);
  const message = scrub(thrown.message, ctx);
  const stack = thrown.stack ?? "";
  if (message === thrown.message && inner === thrown.cause && scrub(stack, ctx) === stack) return thrown;
  const options = inner === undefined ? undefined : { cause: inner };
  // Keep the library's own classes (a RegionalstatistikNetworkError stays one); anything else
  // becomes a plain Error carrying the original name.
  const copy =
    thrown instanceof RegionalstatistikError
      ? new (thrown.constructor as new (m: string, o?: { cause?: unknown }) => Error)(message, options)
      : new Error(message, options);
  copy.name = thrown.name;
  const code = (thrown as { code?: unknown }).code;
  if (code !== undefined) Object.assign(copy, { code });
  return copy;
}

/** The `{ Code, Content, Type }` status object of a GENESIS reply. */
interface GenesisStatus {
  Code?: unknown;
  Content?: unknown;
  Type?: unknown;
}

/**
 * Find the GENESIS status in a parsed body: the envelope's `Status` object, or a
 * flat top-level `{ Code, Content, Type }` (the auth-failure shape). Returns
 * undefined for anything else — including helloworld/logincheck, whose `Status`
 * is a plain string, and whoami, which has neither.
 */
function genesisStatus(parsed: unknown): GenesisStatus | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const top = parsed as GenesisStatus & { Status?: unknown };
  if (top.Status !== undefined) {
    return top.Status && typeof top.Status === "object" && !Array.isArray(top.Status)
      ? (top.Status as GenesisStatus)
      : undefined;
  }
  if (typeof top.Code === "number" && typeof top.Type === "string") return top;
  return undefined;
}

/** Drop a leading UTF-8 byte order mark (this host puts one on its HTML error pages). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    // Every base-URL rule (http(s) only, no userinfo, query, fragment or
    // whitespace), on the raw value — before the trailing-slash strip, so
    // "https://h/ " cannot slip through. A bad base URL is a configuration error
    // (RegionalstatistikValidationError), not a network failure; the default
    // transport still checks the scheme per hop. The engine is exported and may
    // be handed a custom transport that does no such check, so this gate matters.
    assertValid("baseUrl", baseUrl, baseUrlProblem);
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    // Only `undefined` selects the default; a given value must be a valid header
    // value (a blank one is rejected, not silently replaced).
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    const defaultHeaders = options.defaultHeaders ?? {};
    for (const [name, value] of Object.entries(defaultHeaders)) {
      assertValid("defaultHeaders name", name, headerNameProblem);
      assertValid(`defaultHeaders["${name}"]`, value, headerValueProblem);
    }
    this.defaultHeaders = defaultHeaders;
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 0, MAX_TIMEOUT_MS) ?? 30_000;
    this.maxRetries = intOption("maxRetries", options.maxRetries, 0, MAX_RETRIES) ?? 2;
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 0, Number.MAX_SAFE_INTEGER) ?? 200;
    this.maxResponseBytes =
      intOption("maxResponseBytes", options.maxResponseBytes, 0, Number.MAX_SAFE_INTEGER) ??
      DEFAULT_MAX_RESPONSE_BYTES;
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

    const ctx = contextOf(options.authHeaders);
    let attempt = 0;
    for (;;) {
      let response: Awaited<ReturnType<Transport>>;
      try {
        response = await this.transport({
          method,
          url,
          headers,
          ...(body !== undefined ? { body } : {}),
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A transport's message may quote the request, headers included.
        throw scrubThrown(cause, ctx);
      }

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      // Sanitize the server-controlled Content-Type at the source: it is echoed
      // to stderr by renderRaw, so strip any embedded terminal control chars.
      const contentType = sanitizeServerText(String(response.headers["content-type"] ?? ""));
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, ctx);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** GET a JSON body without credentials (helloworld/whoami). */
  async getJson<T>(path: string): Promise<T> {
    const res = await this.request("GET", path, { accept: "application/json" });
    return this.decodeJson<T>("GET", path, res, contextOf(undefined));
  }

  /** POST form-encoded params (with credential headers) and parse the JSON reply. */
  async postJson<T>(
    path: string,
    params: QueryParams,
    authHeaders: Record<string, string>,
  ): Promise<T> {
    const res = await this.request("POST", path, { params, accept: "application/json", authHeaders });
    return this.decodeJson<T>("POST", path, res, contextOf(authHeaders));
  }

  /**
   * POST form-encoded params and return the raw bytes (file / binary downloads).
   *
   * A `data/*file` endpoint answers with a file (a ZIP wrapper), so a JSON or
   * empty reply is never a download: it is a GENESIS status the server sent
   * instead of the file (a credential, "too large" or "no such object" reply),
   * and handing it back would let a caller save `{"Status":…}` as `x.zip`.
   *  - an empty body → `RegionalstatistikParseError`;
   *  - a JSON body with a GENESIS status (enveloped or flat) → the logical-error
   *    mapping (90, 98, error `Type`), and otherwise a `RegionalstatistikApiError`
   *    with that status — including `104` ("keine Objekte"), which for a download
   *    means "no such object" (`isNotFound`, exit 4 in the CLI);
   *  - any other JSON, or a body labelled JSON that does not parse →
   *    `RegionalstatistikParseError`.
   * A body counts as JSON when its Content-Type says so or it starts with `{`
   * (after an optional UTF-8 BOM), whatever the Content-Type claims.
   */
  async postRaw(
    path: string,
    accept: string,
    params: QueryParams,
    authHeaders: Record<string, string>,
  ): Promise<RawResponse> {
    const res = await this.request("POST", path, { params, accept, authHeaders });
    if (res.data.length === 0) {
      throw new RegionalstatistikParseError(`Empty response body from ${path}: expected a file download.`);
    }
    const jsonType = /json/i.test(res.contentType);
    const ctx = contextOf(authHeaders);
    const raw = stripBom(res.data.toString("utf8"));
    if (!jsonType && !raw.trimStart().startsWith("{")) return res;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      if (!jsonType) return res; // starts with "{" but is not JSON: a real file
      throw new RegionalstatistikParseError(
        `Expected a file download from ${path}, got an unparseable reply labelled ${res.contentType}.`,
        { cause: scrubThrown(cause, ctx) },
      );
    }
    const url = this.buildUrl(path);
    const text = scrub(raw, ctx);
    const sent = ctx.sent;
    this.checkLogicalStatus("POST", url, text, parsed, ctx);
    const s = genesisStatus(parsed);
    if (s === undefined) {
      throw new RegionalstatistikParseError(
        `Expected a file download from ${path}, got a JSON reply without a GENESIS status.`,
      );
    }
    const code = typeof s.Code === "number" ? s.Code : undefined;
    const type = typeof s.Type === "string" ? sanitizeServerText(scrub(s.Type, ctx)) : undefined;
    const content = typeof s.Content === "string" ? sanitizeServerText(scrub(s.Content, ctx)) : undefined;
    throw new RegionalstatistikApiError({
      method: "POST",
      url: redactUrl(url),
      body: text,
      ...(sent !== undefined ? { credentialsSent: sent } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(type !== undefined ? { statusType: type } : {}),
      detail: `${content ? `${content} — ` : ""}the server sent this status instead of a file`,
    });
  }

  private decodeJson<T>(
    method: "GET" | "POST",
    path: string,
    res: RawResponse,
    ctx: RequestContext,
  ): T {
    // A leading BOM would make JSON.parse fail (this host's HTML error pages carry
    // one, so a BOM-prefixed JSON reply is plausible too).
    const text = stripBom(res.data.toString("utf8"));
    // Every GENESIS endpoint answers with a JSON body (the envelope, or the
    // helloworld objects); an empty 200 or a 204 is a broken response, not a
    // result — returning null would print "null" with exit 0.
    if (res.status === 204 || text.trim().length === 0) {
      throw new RegionalstatistikParseError(`Empty response body from ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new RegionalstatistikParseError(`Failed to parse JSON response from ${path}`, { cause: scrubThrown(cause, ctx) });
    }
    this.checkLogicalStatus(method, this.buildUrl(path), scrub(text, ctx), parsed, ctx);
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
    ctx: RequestContext,
  ): void {
    // helloworld/logincheck put a plain string in `Status`; only the object form
    // (or the flat auth-failure shape) carries a logical `Code` worth inspecting.
    const s = genesisStatus(parsed);
    if (s === undefined) return;
    const code = typeof s.Code === "number" ? s.Code : undefined;
    if (code === undefined || code === CODE_EMPTY) return;

    // Type / Content are server-controlled and reach the terminal via the error
    // message; strip any embedded terminal control characters (and any echoed
    // credential) at the source. `body` comes scrubbed.
    const type = typeof s.Type === "string" ? sanitizeServerText(scrub(s.Type, ctx)) : undefined;
    const content = typeof s.Content === "string" ? sanitizeServerText(scrub(s.Content, ctx)) : undefined;
    const sent = ctx.sent;
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
        ...(sent !== undefined ? { credentialsSent: sent } : {}),
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
    ctx: RequestContext,
  ): RegionalstatistikApiError {
    const sent = ctx.sent;
    // Scrubbed first: everything below (detail, statusType, body) derives from it.
    const text = scrub(body.toString("utf8"), ctx);
    let detail: string | undefined;
    let code: number | undefined;
    let statusType: string | undefined;
    if (status >= 300 && status < 400) {
      detail = "unexpected redirect — use the canonical host (default https://www.regionalstatistik.de)";
    } else {
      try {
        const parsed = JSON.parse(stripBom(text)) as {
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
        const snippet = stripBom(text).trim().replace(/\s+/g, " ");
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
      ...(sent !== undefined ? { credentialsSent: sent } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(statusType !== undefined ? { statusType } : {}),
      detail,
    });
  }
}
