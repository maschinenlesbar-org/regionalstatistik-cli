// Public entry point for the API client library.

export { RegionalstatistikClient } from "./client.js";
export type { RegionalstatistikClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  redactUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  RegionalstatistikError,
  RegionalstatistikApiError,
  RegionalstatistikNetworkError,
  RegionalstatistikUsageError,
  RegionalstatistikValidationError,
  RegionalstatistikParseError,
} from "./errors.js";
export {
  assertRequestParams,
  assertValid,
  BASE_URL_USERINFO_PROBLEM,
  baseUrlProblem,
  CREDENTIAL_PAIR_PROBLEM,
  credentialPairProblem,
  credentialProblem,
  CREDENTIALS_REQUIRED_PROBLEM,
  credentialsRequiredProblem,
  headerNameProblem,
  headerValueProblem,
  intRangeProblem,
  nonBlankProblem,
  oneOfProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./params.js";
export * from "./types.js";
