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

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  timeoutMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { TextDecoder } from "node:util";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  RegionalstatistikApiError,
  RegionalstatistikError,
  RegionalstatistikNetworkError,
  RegionalstatistikParseError,
  credentialsIn,
  cutText,
  redactCredentials,
  redactSecrets,
} from "./errors.js";
import {
  assertValid,
  baseUrlProblem,
  functionProblem,
  headerNameProblem,
  headerValueProblem,
  intRangeProblem,
  plainObjectProblem,
} from "./validate.js";

export const DEFAULT_BASE_URL = "https://www.regionalstatistik.de";

/** True for a loopback host: `localhost`, 127.0.0.0/8 or `::1` (as URL#hostname spells it). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Whether requests to `baseUrl` would travel unencrypted, as one sentence for a
 * warning (no prefix), or `undefined` when they would not: for
 * `https:`, for a URL that does not parse, and for a loopback host (`localhost`,
 * 127.0.0.0/8, `::1`), where nothing leaves the machine.
 *
 * The sentence names the host (`url.host`: host and port, never the userinfo) and what
 * secret travels with the requests: the base URL's credentials when it carries
 * userinfo (which `baseUrlProblem` rejects for a client, but the check stays general),
 * and every phrase in `secrets` — noun phrases such as `"the token"` or `"the login"`.
 * It never contains a password or token. The CLI logs it once per run as a
 * `WARN` record of `regstat.http` on stderr.
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const userinfo = url.username !== "" || url.password !== "";
  const phrases = [...secrets, ...(userinfo ? ["the base URL's credentials"] : [])];
  if (phrases.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const verb = phrases.length === 1 && !userinfo ? "is" : "are";
  return `${phrases.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}
const DEFAULT_USER_AGENT = "regionalstatistik-cli";
// The charset is REQUIRED: without it GENESIS decodes the body as Latin-1, so a
// UTF-8 umlaut (e.g. "Bevölkerung") arrives mojibaked and matches nothing.
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=UTF-8";

// GENESIS logical `Status.Code` values this engine acts on. The documented success
// codes (0 ok, 22 ok-with-auto-correction, 50 no-newer-data) and 104 (empty) are
// returned as-is so the caller sees the full envelope (Status.Content carries any
// warning text); any other code is an error, whatever its `Type` says.
const SUCCESS_CODES: ReadonlySet<number> = new Set([0, 22, 50]);
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
  /**
   * Swappable transport. Defaults to the built-in node http/https transport. The engine
   * enforces `timeoutMs` and `maxResponseBytes` whatever the transport does, reads a
   * `Headers`/`Map` or any-case header record and any `ArrayBuffer` view as the body,
   * and turns everything a transport throws or returns malformed into a
   * `RegionalstatistikNetworkError`.
   */
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
   * only idle gaps: 0 to `MAX_TIMEOUT_MS` (2^31 - 1 ms); 0 disables. Enforced by the
   * engine for every transport: the request's `signal` is aborted at the deadline and
   * the call rejects with a `RegionalstatistikNetworkError`.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, 0..`MAX_RETRIES`
   * (10). Each waits `retryDelayMs * attempt`, or the response's `Retry-After` when that
   * is longer (up to `MAX_RETRY_AFTER_MS`; a longer one is not retried, and the error
   * says so).
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly); a Retry-After can
   * lengthen a wait, never shorten it. At most `MAX_RETRY_AFTER_MS` (a longer delay
   * would overflow Node's timers and fire at once).
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * The default transport stops reading at the cap; for any other the engine checks
   * the body it gets back.
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
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a server-controlled string — `Status.Content`/`Type`, a plain-text error
 * body, the echoed `Content-Type` — safe to print into a one-line message on
 * stderr:
 *
 * - C0 and C1 controls and DEL are dropped. A hostile or MITM'd endpoint could
 *   otherwise drive ANSI/OSC sequences into the terminal (display spoofing, title
 *   changes).
 * - Bidi formatting characters (isBidiControl) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — CR, LF, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line: the live wrong-
 *   credentials text ("… Nutzernamen bzw.\n das Passwort.") no longer splits the
 *   log record, a CR can't return to column 0 and overwrite it, and a server
 *   can't forge a log record of its own.
 *
 * Implemented as a code-point filter so this source file never contains a raw
 * control byte.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
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

/**
 * Why a transport's resolved value is not a usable HttpResponse, or `undefined` when
 * it is. An injected transport may resolve with anything; a malformed one would
 * otherwise surface as a raw TypeError, outside the RegionalstatistikError contract.
 */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by
 * internal slot, not `instanceof`, so a value from another realm (a vm context, a Jest
 * test) counts. Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which passes as an object but has no
 * plain properties: the engine then saw no Retry-After and no Content-Type at all. Such
 * an object (anything with `get` and `forEach`, a `Map` too) is copied into a record; a
 * plain record gets its names lower-cased, as the engine reads them.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  // Node's transport lower-cases header names; a custom one may not ("Content-Type").
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/**
 * True when `actual` is on another origin (scheme, host, port) than `requested`, or
 * doesn't parse — the credential headers must not have gone there.
 */
function otherOrigin(requested: string, actual: string): boolean {
  try {
    return new URL(actual, requested).origin !== new URL(requested).origin;
  } catch {
    return true;
  }
}

/** The documented shape a JSON answer must have; see `shapeProblem`. */
export type ResponseShape = "envelope" | "whoami" | "unchecked";

/** The `find` result arrays and the catalogue `List`: an array, or `null` (not searched / empty). */
const LIST_KEYS = ["List", "Tables", "Statistics", "Cubes", "Timeseries", "Variables"] as const;

/**
 * Why a parsed 2xx answer does not have the documented shape, or `undefined` when it
 * does (P9). Without this, `null`, `{}`, `[]`, an unrelated error object or an HTML
 * page decoded as JSON were handed back as data with exit 0.
 *
 *  - `envelope` (find, catalogue, metadata, data): an object whose `Status` is an
 *    object with a numeric `Code` (error statuses were raised before this check); a
 *    list (`List`, `Tables`, …) present must be an array or `null`, an `Object`
 *    present an object or `null`;
 *  - `whoami`: an object with a string `User-Agent`;
 *  - `unchecked`: anything (the caller checks it — `logincheck`).
 */
function shapeProblem(parsed: unknown, shape: ResponseShape): string | undefined {
  if (shape === "unchecked") return undefined;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "not a JSON object";
  const body = parsed as Record<string, unknown>;
  if (shape === "whoami") return typeof body["User-Agent"] === "string" ? undefined : 'no "User-Agent"';
  const status = body["Status"];
  if (typeof status !== "object" || status === null || Array.isArray(status)) return "no GENESIS Status object";
  if (statusCode((status as GenesisStatus).Code) === undefined) return "a Status without a numeric Code";
  for (const key of LIST_KEYS) {
    const value = body[key];
    if (value !== undefined && value !== null && !Array.isArray(value)) return `"${key}" is not a list`;
  }
  const object = body["Object"];
  if (object !== undefined && object !== null && (typeof object !== "object" || Array.isArray(object))) {
    return '"Object" is not an object';
  }
  return undefined;
}

/**
 * How GENESIS words a login-check outcome in `Status` when it is a plain string: the
 * success text ("Sie wurden erfolgreich an- und abgemeldet!", English "…successfully…")
 * and the failure text seen live on 2026-10-05 ("Ein Fehler ist aufgetreten. (Bitte
 * prüfen und korrigieren Sie Ihren Nutzernamen oder Ihren Token bzw. das Passwort.)").
 * A failure word wins over a success word.
 */
const LOGIN_FAILED_TEXT = /fehler|error|fail|ungültig|invalid|falsch|wrong|nicht|not\b|prüfen|korrigieren/i;
const LOGIN_OK_TEXT = /erfolgreich|success/i;

/** What a login-check answer says about the credentials. */
export type LoginVerdict =
  | { outcome: "accepted" }
  | { outcome: "rejected"; detail: string | undefined; code?: number; statusType?: string }
  | { outcome: "malformed"; problem: string };

/**
 * Evaluate a parsed `helloworld/logincheck` answer (P18). GENESIS answers a login check
 * with HTTP 200 whether or not the credentials are right; the outcome is in the body:
 *
 *  - `Status` as a **string** (the live shape): an error text means rejected, a success
 *    text accepted;
 *  - `Status` as an **object**, or a flat `{ Code, Content, Type }` (the shape of every
 *    other GENESIS answer and of the auth errors): an error `Type`, or a `Code` other
 *    than 0/22, means rejected;
 *  - **`Username`**, the account the server logged in: it must be a non-empty string.
 *    Live, a wrong token comes back echoed as the `Username`; when the `Status` is
 *    neither a success nor an error text, a `Username` that equals the token sent
 *    (`token`, when the login was by token) counts as rejected too.
 *
 * Anything else — no `Status`, an unrecognised text without that echo, no `Username` —
 * is `malformed`: the check confirmed nothing.
 */
export function loginVerdict(parsed: unknown, token?: string): LoginVerdict {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { outcome: "malformed", problem: "not a JSON object" };
  }
  const body = parsed as { Status?: unknown; Username?: unknown };
  const username = typeof body.Username === "string" && body.Username.trim() !== "" ? body.Username : undefined;
  let verdict: "accepted" | "rejected" | "unknown";
  let detail: string | undefined;
  let code: number | undefined;
  let statusType: string | undefined;
  if (typeof body.Status === "string") {
    detail = body.Status;
    verdict = LOGIN_FAILED_TEXT.test(body.Status) ? "rejected" : LOGIN_OK_TEXT.test(body.Status) ? "accepted" : "unknown";
  } else {
    const s = genesisStatus(parsed);
    if (s === undefined) return { outcome: "malformed", problem: "no GENESIS Status" };
    code = statusCode(s.Code);
    statusType = typeof s.Type === "string" ? s.Type : undefined;
    detail = typeof s.Content === "string" ? s.Content : undefined;
    const errorType = statusType !== undefined && /error|fehler/i.test(statusType);
    verdict = errorType || (code !== undefined && code !== 0 && code !== 22) ? "rejected" : code === undefined ? "unknown" : "accepted";
  }
  if (verdict === "unknown" && token !== undefined && username === token) verdict = "rejected";
  if (verdict === "rejected") {
    return { outcome: "rejected", detail, ...(code !== undefined ? { code } : {}), ...(statusType !== undefined ? { statusType } : {}) };
  }
  if (verdict === "unknown") return { outcome: "malformed", problem: "a Status that says neither success nor failure" };
  if (username === undefined) return { outcome: "malformed", problem: 'no "Username"' };
  return { outcome: "accepted" };
}

/** True for a ZIP file's local-header or empty-archive signature. */
function isZip(data: Buffer): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05);
}

/** The charset a Content-Type names, or undefined when it names none. */
function charsetOf(contentType: string): string | undefined {
  return /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1];
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none; a byte-order mark is dropped). GENESIS declares `charset=UTF-8`, but a mirror
 * or proxy answering in ISO-8859-1 would otherwise turn every umlaut into U+FFFD. An
 * unknown charset label is a `RegionalstatistikParseError`.
 */
function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = charsetOf(contentType) ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new RegionalstatistikParseError(`Unsupported response charset "${sanitizeServerText(charset)}" from ${path}.`);
  }
  return decoder.decode(body);
}

/** decodeBody for error text: an unknown charset falls back to UTF-8 rather than hide the error. */
function decodeErrorBody(body: Buffer, contentType: string): string {
  try {
    return decodeBody(body, contentType, "");
  } catch {
    return body.toString("utf8");
  }
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

/**
 * A GENESIS status code as a number. GENESIS stringifies many fields
 * (`"pagelength":"100"`), so a numeric string (`"90"`) counts too; anything else
 * is undefined.
 */
function statusCode(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
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
  if (statusCode(top.Code) !== undefined && typeof top.Type === "string") return top;
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
    this.transport =
      options.transport === undefined ? nodeHttpTransport : assertValid("transport", options.transport, functionProblem);
    // Only `undefined` selects the default; a given value must be a valid header
    // value (a blank one is rejected, not silently replaced).
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    const defaultHeaders = options.defaultHeaders === undefined ? {} : assertValid("defaultHeaders", options.defaultHeaders, plainObjectProblem);
    for (const [name, value] of Object.entries(defaultHeaders)) {
      assertValid("defaultHeaders name", name, headerNameProblem);
      assertValid(`defaultHeaders["${name}"]`, value, headerValueProblem);
    }
    this.defaultHeaders = defaultHeaders;
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 0, MAX_TIMEOUT_MS) ?? 30_000;
    this.maxRetries = intOption("maxRetries", options.maxRetries, 0, MAX_RETRIES) ?? 2;
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 0, MAX_RETRY_AFTER_MS) ?? 200;
    this.maxResponseBytes =
      intOption("maxResponseBytes", options.maxResponseBytes, 0, Number.MAX_SAFE_INTEGER) ??
      DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep === undefined ? realSleep : assertValid("sleep", options.sleep, functionProblem);
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the
   * transport stops or not — a custom transport (fetch, a node:http wrapper) that
   * ignores `timeoutMs` can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new RegionalstatistikNetworkError(timeoutMessage(this.timeoutMs));
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
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
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          redirect: "manual",
          headers,
          ...(body !== undefined ? { body } : {}),
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A transport's message may quote the request, headers included, so it is
        // scrubbed. The default transport rejects with RegionalstatistikNetworkError only; an
        // injected one may throw anything (fetch's TypeError, a string, null). Keep the
        // library's error contract for both: every failure is a RegionalstatistikError. Resets
        // are not retried (only 429/503 are, see Usage.md).
        const clean = scrubThrown(cause, ctx);
        if (clean instanceof RegionalstatistikError) throw clean;
        const reason = clean instanceof Error ? clean.message : String(clean);
        throw new RegionalstatistikNetworkError(`${method} ${redactUrl(url)} failed: ${sanitizeServerText(reason)}`, {
          cause: clean,
        });
      }

      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new RegionalstatistikNetworkError(
          `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      // A transport that followed a redirect anyway (fetch's default) has already sent
      // the credential headers on; at least don't hand back the other host's answer.
      const finalUrl = (response as { url?: unknown }).url;
      if (typeof finalUrl === "string" && finalUrl !== "" && otherOrigin(url, finalUrl)) {
        throw new RegionalstatistikNetworkError(
          `${method} ${redactUrl(url)} failed: the transport followed a redirect to another origin ` +
            `(${sanitizeServerText(redactUrl(finalUrl))}); transports must not follow redirects ` +
            `(HttpRequest.redirect is "manual") — use the canonical host (default https://www.regionalstatistik.de)`,
        );
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      const responseBody = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a
      // custom one may have read everything.
      if (this.maxResponseBytes > 0 && responseBody.byteLength > this.maxResponseBytes) {
        throw new RegionalstatistikNetworkError(`${method} ${redactUrl(url)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }
      const retryable = status === 429 || status === 503;
      let retryNote: string | undefined;
      if (retryable && attempt < this.maxRetries) {
        // Back off linearly from retryDelayMs. A Retry-After can ask for longer, never
        // for less: `Retry-After: 0` or a date in the past turned the retries into a
        // zero-delay burst against a server that had just asked for less load. One
        // beyond MAX_RETRY_AFTER_MS is not retried at all — retrying early would only
        // land inside the window the server asked us to wait out — and the error says so.
        const backoff = this.retryDelayMs * (attempt + 1);
        const retryAfter = parseRetryAfter(responseHeaders["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
          continue;
        }
        retryNote =
          `the server asked to wait ${Math.ceil(retryAfter / 1000)} s before retrying (Retry-After), ` +
          `longer than the ${MAX_RETRY_AFTER_MS / 1000} s the client waits; retries won't help — try again later`;
      }

      // Sanitize the server-controlled Content-Type at the source: it is echoed
      // to stderr by renderRaw, so strip any embedded terminal control chars.
      const contentType = sanitizeServerText(String(responseHeaders["content-type"] ?? ""));
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, responseBody, ctx, retryNote, contentType);
      }

      return { data: responseBody, contentType, status };
    }
  }

  /** GET a JSON body without credentials (helloworld/whoami), checked against `shape`. */
  async getJson<T>(path: string, shape: ResponseShape = "whoami"): Promise<T> {
    const res = await this.request("GET", path, { accept: "application/json" });
    return this.decodeJson<T>("GET", path, res, contextOf(undefined), shape);
  }

  /**
   * POST form-encoded params (with credential headers) and parse the JSON reply, which
   * must have the GENESIS envelope unless `shape` says otherwise.
   */
  async postJson<T>(
    path: string,
    params: QueryParams,
    authHeaders: Record<string, string>,
    shape: ResponseShape = "envelope",
  ): Promise<T> {
    const res = await this.request("POST", path, { params, accept: "application/json", authHeaders });
    return this.decodeJson<T>("POST", path, res, contextOf(authHeaders), shape);
  }

  /**
   * POST `helloworld/logincheck` and evaluate the answer (`loginVerdict`, P18): resolves
   * only when GENESIS confirms the login. Rejected credentials — live an HTTP 200 whose
   * `Status` is an error text, the token echoed as `Username` — reject with a
   * `RegionalstatistikApiError` whose `loginRejected` (and so `isAuthError`) is true; an answer
   * that confirms nothing is a `RegionalstatistikParseError`. The 401/404 auth answers and the
   * transport errors keep their usual mapping.
   */
  async postLoginCheck<T>(path: string, params: QueryParams, authHeaders: Record<string, string>): Promise<T> {
    const res = await this.request("POST", path, { params, accept: "application/json", authHeaders });
    const ctx = contextOf(authHeaders);
    const text = decodeBody(res.data, res.contentType, path);
    if (text.trim().length === 0) throw new RegionalstatistikParseError(`Empty response body from ${path}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new RegionalstatistikParseError(`Failed to parse JSON response from ${path}`, { cause: scrubThrown(cause, ctx) });
    }
    // In token mode the token travels alone in the `username` header.
    const token = authHeaders["password"] === undefined ? authHeaders["username"] : undefined;
    const verdict = loginVerdict(parsed, token);
    if (verdict.outcome === "malformed") {
      throw new RegionalstatistikParseError(`Unexpected response from ${path}: ${verdict.problem}; the login was not confirmed.`);
    }
    if (verdict.outcome === "rejected") {
      const detail = verdict.detail === undefined ? undefined : sanitizeServerText(scrub(verdict.detail, ctx));
      throw new RegionalstatistikApiError({
        method: "POST",
        url: redactUrl(this.buildUrl(path)),
        body: scrub(text, ctx),
        httpStatus: res.status,
        ...(verdict.code !== undefined ? { code: verdict.code } : {}),
        ...(verdict.statusType !== undefined ? { statusType: sanitizeServerText(scrub(verdict.statusType, ctx)) } : {}),
        ...(ctx.sent !== undefined ? { credentialsSent: ctx.sent } : {}),
        detail: detail === undefined || detail === "" ? "the server did not accept the credentials" : detail,
        loginRejected: true,
      });
    }
    return parsed as T;
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
    // A body labelled JSON is decoded by its charset; anything else is only sniffed
    // (after an optional UTF-8 BOM).
    const raw = jsonType ? decodeBody(res.data, res.contentType, path) : stripBom(res.data.toString("utf8"));
    // An HTML page (a maintenance or proxy page, a login portal) is not the file either;
    // a ZIP — what GENESIS delivers for every format — always counts as one. Only a
    // download asked for as `format: "html"` may be HTML itself.
    const htmlPage = /html/i.test(res.contentType) || /^\s*(<!doctype html|<html)/i.test(raw.slice(0, 1024).replace(/^\uFEFF/, ""));
    if (!isZip(res.data) && htmlPage && params["format"] !== "html") {
      throw new RegionalstatistikParseError(
        `Expected a file download from ${path}, got an HTML page (Content-Type ${res.contentType || "none"}); nothing was saved.`,
      );
    }
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
    const code = statusCode(s.Code);
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
    shape: ResponseShape,
  ): T {
    const text = decodeBody(res.data, res.contentType, path);
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
    const problem = shapeProblem(parsed, shape);
    if (problem !== undefined) {
      throw new RegionalstatistikParseError(`Unexpected response from ${path}: ${problem}.`);
    }
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
    // GENESIS stringifies many fields, so a numeric string ("90") counts as the code.
    const code = statusCode(s.Code);

    // Type / Content are server-controlled and reach the terminal via the error
    // message; strip any embedded terminal control characters (and any echoed
    // credential) at the source. `body` comes scrubbed.
    const type = typeof s.Type === "string" ? sanitizeServerText(scrub(s.Type, ctx)) : undefined;
    const content = typeof s.Content === "string" ? sanitizeServerText(scrub(s.Content, ctx)) : undefined;
    const sent = ctx.sent;
    const isErrorType = type !== undefined && /error|fehler/i.test(type);
    // Key off the numeric Code: the documented success codes and 104 (empty) pass,
    // unless the Type calls it an error. A missing code is left to the shape check.
    // Any other code — 90, 98, or one this client doesn't know, whatever its Type
    // ("Information", "Warnung") — is an error, never data with exit 0.
    if (!isErrorType && (code === undefined || code === CODE_EMPTY || SUCCESS_CODES.has(code))) return;

    const detail =
      code === CODE_TOO_LARGE
        ? `${content ?? "result too large"} — this read-only CLI does not run the async batch-job flow; narrow the selection (--start-year/--end-year/--timeslices/--region-key/--class-key) or download a smaller subset`
        : content;
    // The flat `{ Code, Content, Type }` shape (no envelope) is GENESIS' auth-failure
    // reply. The live host pairs it with 401/404, but it has also sent it on HTTP 200;
    // carry that status so a flat Code 2 counts as an auth error there too (isAuthError).
    const flat = (parsed as { Status?: unknown }).Status === undefined;
    throw new RegionalstatistikApiError({
      method,
      url: redactUrl(url),
      body,
      ...(flat ? { httpStatus: 200 } : {}),
      ...(sent !== undefined ? { credentialsSent: sent } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(type !== undefined ? { statusType: type } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
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
    note?: string,
    contentType = "",
  ): RegionalstatistikApiError {
    const sent = ctx.sent;
    // Scrubbed first: everything below (detail, statusType, body) derives from it.
    const text = scrub(decodeErrorBody(body, contentType), ctx);
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
          code = statusCode(s.Code);
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
          detail = snippet.length > 200 ? `${cutText(snippet, 200)}…` : snippet;
        }
      }
      // All branches take server-controlled text; strip terminal control chars
      // before it reaches stderr.
      if (detail !== undefined) detail = sanitizeServerText(detail);
      if (statusType !== undefined) statusType = sanitizeServerText(statusType);
    }
    if (note !== undefined) detail = detail === undefined ? note : `${detail} — ${note}`;
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
