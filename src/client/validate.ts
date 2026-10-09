// Input validation for the library. Every rule about what a request may contain
// lives here (or is called from here), so the client enforces it before any
// request and the CLI's commander parsers call the very same functions instead
// of keeping their own copies.
//
//   - A `Problem` returns the reason a value is invalid, or `undefined` if it is
//     valid. Reasons never echo the value (it may be a credential).
//   - `assertValid` turns a reason into a `RegionalstatistikValidationError` with
//     the message `Invalid <name>: <reason>`.

import { RegionalstatistikValidationError, cutForMessage } from "./errors.js";
import {
  BOOLEAN_PARAM_KEYS,
  CRITERIA,
  DATA_FILE_FORMATS,
  FIND_CATEGORIES,
  LANGUAGES,
  MAX_PAGELENGTH,
  type ParamOptions,
} from "./params.js";

/** Returns why `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw a `RegionalstatistikValidationError` (`Invalid <name>: <reason>`) when
 * `problem` finds `value` invalid; otherwise return `value` unchanged.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new RegionalstatistikValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * A required or given text value must not be blank (`""` or whitespace only):
 * GENESIS reads an empty parameter as "no filter", so a blank filter would
 * silently return unfiltered data. A non-string counts as missing.
 */
export function nonBlankProblem(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? undefined : "Expected a non-empty value.";
}

/**
 * A value must be one of `allowed` (exact, case-sensitive match). The reason
 * lists the allowed values, worded like commander's `.choices()` error.
 */
export function oneOfProblem(allowed: readonly string[]): Problem<unknown> {
  return (value) =>
    (allowed as readonly unknown[]).includes(value) ? undefined : `Allowed choices are ${allowed.join(", ")}.`;
}

/**
 * A value must be a safe integer from `min` to `max` (`min` >= 0). The reasons
 * are worded like the CLI's integer parsers.
 */
export function intRangeProblem(min: number, max: number): Problem<unknown> {
  return (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return "Expected a non-negative integer.";
    }
    if (value < min) return `Must be >= ${min}.`;
    if (value > max) return `Must be <= ${max}.`;
    return undefined;
  };
}

/** The GENESIS request parameters with a rule beyond "non-blank", and that rule. */
const RULES: Readonly<Record<string, Problem<unknown>>> = {
  pagelength: intRangeProblem(1, MAX_PAGELENGTH),
  timeslices: intRangeProblem(0, Number.MAX_SAFE_INTEGER),
  language: oneOfProblem(LANGUAGES),
  category: oneOfProblem(FIND_CATEGORIES),
  searchcriterion: oneOfProblem(CRITERIA),
  sortcriterion: oneOfProblem(CRITERIA),
  format: oneOfProblem(DATA_FILE_FORMATS),
};

/** A `true`/`false` parameter (`structureinformation`, `compress`, `transpose`). */
export function booleanProblem(value: unknown): string | undefined {
  return typeof value === "boolean" ? undefined : "Expected true or false.";
}

/** A free-text parameter (`selection`, `startyear`, `classifyingkey1`, …): a non-blank string. */
export function textProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  return nonBlankProblem(value);
}

/** Keys that are never a parameter: they would reach Object.prototype in a careless consumer. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Check the parameters of one GENESIS request before it is sent. `undefined`
 * and `null` mean "omitted" and are never sent. A parameter with its own rule
 * (`pagelength`, `timeslices`, `language`, `category`, the criteria, `format`, …)
 * must pass it, `structureinformation`/`compress`/`transpose` must be a boolean;
 * every other parameter a non-blank string. GENESIS takes one value per parameter,
 * so an array is rejected (it went out as repeated keys, of which the server read
 * one). Throws `RegionalstatistikValidationError` naming the parameter.
 *
 * With `allowed`, a key outside that list is rejected too (P10): GENESIS ignores a
 * parameter it does not know and answers unfiltered. `options.allowUnknownParams`
 * lets such a key through as long as its value is a string, number or boolean;
 * `__proto__`, `constructor` and `prototype` are never accepted.
 */
export function assertRequestParams(
  params: Readonly<Record<string, unknown>>,
  allowed?: readonly string[],
  options: ParamOptions = {},
): void {
  for (const [key, value] of Object.entries(params)) {
    if (FORBIDDEN_KEYS.has(key)) throw new RegionalstatistikValidationError(`Invalid params: "${key}" is not a parameter.`);
    if (allowed !== undefined && !allowed.includes(key) && options.allowUnknownParams !== true) {
      throw new RegionalstatistikValidationError(
        `Invalid params: unknown parameter "${cutForMessage(key, 100)}" (GENESIS would ignore it and answer unfiltered). ` +
          `Allowed: ${allowed.join(", ")}. Pass { allowUnknownParams: true } to send it anyway.`,
      );
    }
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) throw new RegionalstatistikValidationError(`Invalid ${key}: GENESIS takes one value, not a list.`);
    // An own-property lookup, so a key such as "constructor" is never a rule.
    const rule = Object.prototype.hasOwnProperty.call(RULES, key) ? RULES[key] : undefined;
    if (rule !== undefined) assertValid(key, value, rule);
    else if ((BOOLEAN_PARAM_KEYS as readonly string[]).includes(key)) assertValid(key, value, booleanProblem);
    else if (allowed !== undefined && !allowed.includes(key)) {
      // An unknown key let through by allowUnknownParams: a plain scalar only.
      if (typeof value === "string") assertValid(key, value, nonBlankProblem);
      else if (!(typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
        throw new RegionalstatistikValidationError(`Invalid ${key}: Expected a string, number or boolean.`);
      }
    } else assertValid(key, value, textProblem);
  }
}

/**
 * A value sent in an HTTP header (credentials, User-Agent): non-blank, no C0
 * control character other than tab (so no CR/LF header injection), no DEL, and
 * nothing above U+00FF, which Node's HTTP layer cannot send. Tab and Latin-1
 * (e.g. "ü") are allowed — exactly what Node sends (as single ISO-8859-1 bytes).
 * Checked by char code so the source stays free of control bytes.
 */
export function headerValueProblem(value: unknown): string | undefined {
  // A JavaScript caller may pass anything; say what was wrong rather than "non-empty".
  if (typeof value !== "string") return "Expected a string.";
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  const text = value as string;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
}

/**
 * A credential (token, username, password): a valid header value with no
 * leading or trailing whitespace. An HTTP header cannot carry those — the
 * receiving server strips them as optional whitespace — so "  pass  " could never
 * arrive as given; rejecting it beats silently trimming it into another password.
 */
export function credentialProblem(value: unknown): string | undefined {
  const header = headerValueProblem(value);
  if (header !== undefined) return header;
  return value === (value as string).trim()
    ? undefined
    : "Value has leading or trailing whitespace, which an HTTP header cannot carry.";
}

/** An HTTP header name: one or more token characters (RFC 9110). */
export function headerNameProblem(value: unknown): string | undefined {
  return typeof value === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
    ? undefined
    : "Expected an HTTP header name (token characters only).";
}

/** `baseUrlProblem`'s reason for a base URL with embedded userinfo. */
export const BASE_URL_USERINFO_PROBLEM = "Must not embed credentials (user:pass@host).";

/**
 * A base URL: an absolute `http:`/`https:` URL with no userinfo, no query or
 * fragment, no surrounding whitespace and no whitespace or control character
 * inside. Request paths are appended to it as a string, so `?`/`#` would swallow
 * every path and whitespace would end up in the request path (`new URL()` trims
 * and strips some of it silently, the raw string does not). Userinfo would turn
 * into a Basic Authorization header or leak into messages; GENESIS never uses
 * Basic auth. The reasons never echo the value.
 */
export function baseUrlProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "Must be an absolute http(s) URL.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Must be an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return 'Only "http:" and "https:" URLs are allowed.';
  }
  if (url.username || url.password) return BASE_URL_USERINFO_PROBLEM;
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return "A base URL cannot contain whitespace or control characters.";
  }
  return undefined;
}

/** `credentialPairProblem`'s reason when only one of username/password is set. */
export const CREDENTIAL_PAIR_PROBLEM = "Provide both username and password (or a token).";

/**
 * Username and password come as a pair: with only one of them, a lone username
 * would go out in the token's wire format and a lone password would be dropped.
 * Pass the values after blank-to-unset; a token, when set, makes this moot.
 */
export function credentialPairProblem(creds: { username?: string | undefined; password?: string | undefined }): string | undefined {
  return (creds.username === undefined) === (creds.password === undefined) ? undefined : CREDENTIAL_PAIR_PROBLEM;
}

/** `credentialsRequiredProblem`'s reason when an account-only endpoint has no credentials. */
export const CREDENTIALS_REQUIRED_PROBLEM = "This endpoint needs an account (a token, or a username and password).";

/**
 * GENESIS serves `find`, `catalogue`, `metadata` and `data` only to an account;
 * anonymously it answers 401 + Code 15. A token travels in the `username` field,
 * so a set `username` (after blank-to-unset) means "has credentials".
 */
export function credentialsRequiredProblem(creds: {
  username?: string | undefined;
  password?: string | undefined;
}): string | undefined {
  return creds.username === undefined ? CREDENTIALS_REQUIRED_PROBLEM : undefined;
}

/**
 * True when `value` (as a whole, surrounding whitespace aside) has the shape of a
 * GENESIS API token: 32 letters and digits. The CLI uses it to keep a token typed in
 * the wrong place (`regstat <token> logincheck`, a surplus argument) out of its
 * messages.
 */
export function looksLikeToken(value: string): boolean {
  return /^[A-Za-z0-9]{32}$/.test(value.trim());
}

/**
 * A parameter or options object: a plain object (not `null`, an array, a string or a
 * number). Spreading a string (`{ ..."x" }`) would send `0=x`; spreading a number or
 * `null` would silently drop what the caller meant.
 */
export function plainObjectProblem(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? undefined : "Expected an object.";
}

/** A callback option (`transport`, `sleep`): a function. */
export function functionProblem(value: unknown): string | undefined {
  return typeof value === "function" ? undefined : "Expected a function.";
}
