// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

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
 * (`Status.Content` / `Content`, or a parsed field from an HTTP error body).
 */
export class RegionalstatistikApiError extends RegionalstatistikError {
  readonly httpStatus: number | undefined;
  readonly code: number | undefined;
  readonly statusType: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly detail: string | undefined;

  constructor(args: {
    url: string;
    method: string;
    body: string;
    httpStatus?: number;
    code?: number;
    statusType?: string;
    detail?: string;
  }) {
    const detailPart = args.detail ? `: ${args.detail}` : "";
    const genesisPart =
      args.code !== undefined
        ? `GENESIS status ${args.code}${args.statusType ? ` (${args.statusType})` : ""}`
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
    this.detail = args.detail;
  }

  /**
   * True when the API signalled "no such object": the GENESIS logical code 90
   * (requested object not found), or a transport-level HTTP 404 that did NOT
   * carry a contradicting GENESIS code in its body — the live server answers
   * wrong credentials with HTTP 404 + `{ Code: 2, ... }`, which is an auth
   * problem, not a missing object. Lets the CLI map a genuine miss to a
   * distinct exit code for scripting.
   */
  get isNotFound(): boolean {
    return this.code === 90 || (this.httpStatus === 404 && this.code === undefined);
  }

  /**
   * True when the API rejected the credentials: the GENESIS logical code 15
   * ("Sie sind nicht berechtigt ..." — no/unrecognized credentials) or a
   * transport-level 401/403. The CLI appends a credentials hint for these.
   */
  get isAuthError(): boolean {
    return this.code === 15 || this.httpStatus === 401 || this.httpStatus === 403;
  }

  /** True for HTTP statuses the engine treats as transient and retries. */
  get isRetryable(): boolean {
    return this.httpStatus === 429 || this.httpStatus === 503;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class RegionalstatistikNetworkError extends RegionalstatistikError {}

/**
 * A CLI usage error (bad/missing argument or credentials detected before any
 * request, e.g. only one of --username/--password, or a credential-required
 * command invoked with none). Mapped to the conventional usage exit code 2 so
 * scripts can distinguish it from a runtime error (1).
 */
export class RegionalstatistikUsageError extends RegionalstatistikError {}

/** The response body could not be parsed as the expected JSON shape. */
export class RegionalstatistikParseError extends RegionalstatistikError {}
