// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that
 * don't parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`):
 * the userinfo is everything between `://` and the last `@` before the host. A value
 * without a scheme counts when it reads `user:password@host`. Used to redact those
 * exact strings from text that echoes the value (usage errors, help), whatever
 * characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before
  // the first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them)
 * that is followed by `@` replaced by `***`. Matching the exact strings, not a
 * pattern, covers passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern
 * can delimit.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * `text` with every occurrence of each secret (a token, a username, a password —
 * values with no `@` to anchor on) replaced by `***`, longest first so a secret is
 * never left half-replaced by one of its own substrings. Only whole occurrences
 * count — not one inside a longer run of letters and digits — so the username `user`
 * leaves `--username` alone. Secrets shorter than 4 characters are skipped: they are
 * not plausible GENESIS credentials (a token has 32 characters, a password at least
 * 10), and replacing them would garble the rest of the text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.trim().length < 4) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g"), "***");
  }
  return out;
}

/**
 * Longest server text (in characters) an error keeps as its `detail` and shows in its
 * message; the full answer stays in `body`. A server that answers with a 200 kB error
 * page must not flood stderr.
 */
export const MAX_MESSAGE_VALUE_LENGTH = 500;

/** `text` cut to MAX_MESSAGE_VALUE_LENGTH characters, ending in "…" when cut. */
export function cutForMessage(text: string): string {
  return text.length > MAX_MESSAGE_VALUE_LENGTH ? `${text.slice(0, MAX_MESSAGE_VALUE_LENGTH)}…` : text;
}

/** Base class for every error originating from this client. */
export class RegionalstatistikError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API signalled a failure. GENESIS is unusual: it answers HTTP 200 for most
 * *logical* errors and carries the real outcome in a `Status` object in the
 * body — while authentication failures arrive as a bare `{ Code, Content, Type }`
 * object at the top level, on a non-2xx status (verified live: HTTP 401 with
 * Code 15 for missing credentials, HTTP 404 with Code 2 for wrong credentials —
 * see engine.ts). This error therefore models both worlds, together when needed:
 *
 *  - `httpStatus` is set for transport/HTTP failures (non-2xx, e.g. a 405 on a
 *    GET to an authenticated endpoint or a gateway 502);
 *  - `code` is set for a GENESIS logical error, taken from `Status.Code` or the
 *    flat top-level `Code` (e.g. 90 = object not found, 98 = table too large,
 *    15 = not authorized), with `statusType` the `Type` ("Fehler"/"ERROR").
 *
 * At least one of the two is always present, and both are when a non-2xx reply
 * carried a GENESIS status body; `detail` holds the human-readable message
 * (`Status.Content` / `Content`, or a parsed field from an HTTP error body), cut at
 * `MAX_MESSAGE_VALUE_LENGTH` characters (the full answer is in `body`).
 */
export class RegionalstatistikApiError extends RegionalstatistikError {
  readonly httpStatus: number | undefined;
  readonly code: number | undefined;
  readonly statusType: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly detail: string | undefined;
  /**
   * Whether the failed request carried credentials: `true` if it did, `false` for
   * an endpoint that accepts them but was called without, `undefined` for an
   * endpoint that takes none (`whoami`). Lets the CLI give the right hint — or
   * none — for an auth error.
   */
  readonly credentialsSent: boolean | undefined;

  constructor(args: {
    url: string;
    method: string;
    body: string;
    httpStatus?: number;
    code?: number;
    statusType?: string;
    detail?: string;
    credentialsSent?: boolean;
  }) {
    const detail = args.detail === undefined ? undefined : cutForMessage(args.detail);
    const detailPart = detail ? `: ${detail}` : "";
    const typePart = args.statusType ? ` (${args.statusType})` : "";
    const genesisPart =
      args.code !== undefined
        ? `GENESIS status ${args.code}${typePart}`
        : typePart !== ""
          ? `GENESIS status${typePart}` // an error Type without a usable Code
          : undefined;
    const httpPart = args.httpStatus !== undefined ? `HTTP ${args.httpStatus}` : undefined;
    const head =
      genesisPart !== undefined && httpPart !== undefined
        ? `${genesisPart} / ${httpPart}`
        : (genesisPart ?? httpPart ?? "HTTP 0");
    super(`${head} for ${args.method} ${args.url}${detailPart}`);
    this.httpStatus = args.httpStatus;
    this.code = args.code;
    this.statusType = args.statusType;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = detail;
    this.credentialsSent = args.credentialsSent;
  }

  /**
   * True when the API signalled "no such object": the GENESIS logical code 90
   * (requested object not found), or a transport-level HTTP 404 that did NOT
   * carry a contradicting GENESIS code in its body — the live server answers
   * wrong credentials with HTTP 404 + `{ Code: 2, ... }`, which is an auth
   * problem, not a missing object. Also code 104 ("keine Objekte"), which the
   * engine raises only for a file download (`postRaw`) — on the JSON endpoints
   * 104 is a valid empty result and never thrown. Lets the CLI map a genuine
   * miss to a distinct exit code for scripting.
   */
  get isNotFound(): boolean {
    return (
      this.code === 90 ||
      this.code === 104 ||
      (this.httpStatus === 404 && this.code === undefined)
    );
  }

  /**
   * True when the API rejected the credentials: the GENESIS logical code 15
   * ("Sie sind nicht berechtigt ..." — no/unrecognized credentials), the flat
   * code 2 (wrong username/password or token — the live server's HTTP 404 +
   * `{ Code: 2 }`, and the same flat body on HTTP 200, which the engine reports
   * with `httpStatus: 200`; an enveloped Code 2 carries no HTTP status), or a
   * transport-level 401/403. The CLI appends a credentials hint for these.
   */
  get isAuthError(): boolean {
    return (
      this.code === 15 ||
      (this.code === 2 && this.httpStatus !== undefined) ||
      this.httpStatus === 401 ||
      this.httpStatus === 403
    );
  }

  /** True for HTTP statuses the engine treats as transient and retries. */
  get isRetryable(): boolean {
    return this.httpStatus === 429 || this.httpStatus === 503;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class RegionalstatistikNetworkError extends RegionalstatistikError {}

/**
 * A usage error (bad/missing argument or credentials detected before any
 * request, e.g. only one of username/password, or a credential-required
 * command invoked with none). Mapped to the conventional usage exit code 2 so
 * scripts can distinguish it from a runtime error (1).
 */
export class RegionalstatistikUsageError extends RegionalstatistikError {}

/**
 * The library rejected an input before sending any request (message
 * `Invalid <name>: <reason>`, see `validate.ts`). It extends
 * `RegionalstatistikUsageError`, so existing `instanceof RegionalstatistikUsageError`
 * checks keep catching it, and the CLI maps it to the usage exit code 2.
 */
export class RegionalstatistikValidationError extends RegionalstatistikUsageError {}

/** The response body could not be parsed as the expected JSON shape. */
export class RegionalstatistikParseError extends RegionalstatistikError {}
