// Input validation for the library. Every rule about what a request may contain
// lives here (or is called from here), so the client enforces it before any
// request and the CLI's commander parsers call the very same functions instead
// of keeping their own copies.
//
//   - A `Problem` returns the reason a value is invalid, or `undefined` if it is
//     valid. Reasons never echo the value (it may be a credential).
//   - `assertValid` turns a reason into a `RegionalstatistikValidationError` with
//     the message `Invalid <name>: <reason>`.

import { RegionalstatistikValidationError, quoteValue } from "./errors.js";
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
 * A free-text value as GENESIS matches it (the `find` term): without surrounding
 * whitespace (a term pasted with a trailing space or newline matched nothing) and in
 * composed Unicode, NFC (a decomposed "Bevölkerung", o plus U+0308 as macOS file names
 * produce, matched nothing — P11). Inner whitespace is kept. Check it with
 * {@link textProblem} first. Credentials never go through it.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * A required or given value must not be blank (`""` or whitespace only): GENESIS reads an
 * empty parameter as "no filter", so a blank filter would silently return unfiltered data. A
 * non-string counts as missing. Used for header values; a request value goes through
 * {@link textProblem} or {@link tokenProblem}, which also count invisible characters as blank.
 */
export function nonBlankProblem(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? undefined : "Expected a non-empty value.";
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which the form encoder would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as free text (the `find` term), or undefined when it can. Refused,
 * before any request, as GENESIS would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`): an empty term reads as "no filter";
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is a value GENESIS
 * compares as a code: an object code (`name`), a `selection`, an area, a year, a date, a
 * regional or classifying variable or key. The rules apply to the value with surrounding
 * whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and not only invisible
 * characters or combining marks), no lone surrogate, and no control or format character at all
 * (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible character in a
 * code only ever makes it match nothing (GENESIS then answers Status 104, "nothing found").
 * Inner spaces are allowed (a `selection` searched by content). The reason quotes the value
 * visibly. The value lists (`language`, `category`, the criteria, `format`) are checked against
 * their known values instead (`oneOfProblem`).
 */
export function tokenProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list (`contents`, `--contents A,B`), as typed: each item is
 * checked (`listProblem`) and canonicalised (`normalizeToken`) on its own, so `"A, B"` sends
 * `A,B`, and `"A,,B"`, `"A,"` and `","` are refused rather than sent with an empty item.
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all, or an item that `itemProblem` refuses (by default {@link tokenProblem}: a blank
 * item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<unknown> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i]);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/** A comma-separated list parameter (`contents`): a string whose items pass {@link listProblem}. */
function commaListProblem(value: unknown): string | undefined {
  return typeof value === "string" ? listProblem(splitList(value)) : "Expected a string.";
}

/** The parameters GENESIS takes as a comma-separated list. */
export const LIST_PARAM_KEYS: readonly string[] = ["contents"];


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
  term: textProblem,
  contents: commaListProblem,
};

/** A `true`/`false` parameter (`structureinformation`, `compress`, `transpose`). */
export function booleanProblem(value: unknown): string | undefined {
  return typeof value === "boolean" ? undefined : "Expected true or false.";
}

/** Keys that are never a parameter: they would reach Object.prototype in a careless consumer. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Check the parameters of one GENESIS request before it is sent. `undefined`
 * and `null` mean "omitted" and are never sent. A parameter with its own rule
 * (`pagelength`, `timeslices`, `language`, `category`, the criteria, `format`, …)
 * must pass it, `structureinformation`/`compress`/`transpose` must be a boolean,
 * `term` free text ({@link textProblem}), `contents` a comma-separated list
 * ({@link listProblem}); every other parameter a token ({@link tokenProblem}: not blank or
 * invisible, no control or format character). GENESIS takes one value per parameter,
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
        `Invalid params: unknown parameter ${quoteValue(key)} (GENESIS would ignore it and answer unfiltered). ` +
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
      if (typeof value === "string") assertValid(key, value, tokenProblem);
      else if (!(typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
        throw new RegionalstatistikValidationError(`Invalid ${key}: Expected a string, number or boolean.`);
      }
    } else assertValid(key, value, tokenProblem);
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
