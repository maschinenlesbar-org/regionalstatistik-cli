// Public entry point for the API client library.

export { RegionalstatistikClient } from "./client.js";
export type { RegionalstatistikClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  cleartextProblem,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  loginVerdict,
  parseRetryAfter,
  redactUrl,
} from "./engine.js";
export type { EngineOptions, LoginVerdict, RawResponse, ResponseShape } from "./engine.js";
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
  credentialsIn,
  cutForMessage,
  MAX_MESSAGE_VALUE_LENGTH,
  redactCredentials,
  redactSecrets,
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
  looksLikeToken,
  nonBlankProblem,
  oneOfProblem,
  plainObjectProblem,
  functionProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./params.js";
export * from "./types.js";
