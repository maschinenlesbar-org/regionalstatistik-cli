// Input validation for the library. Every rule about what a request may contain
// lives here (or is called from here), so the client enforces it before any
// request and the CLI's commander parsers call the very same functions instead
// of keeping their own copies.
//
//   - A `Problem` returns the reason a value is invalid, or `undefined` if it is
//     valid. Reasons never echo the value (it may be a credential).
//   - `assertValid` turns a reason into a `RegionalstatistikValidationError` with
//     the message `Invalid <name>: <reason>`.

import { RegionalstatistikValidationError } from "./errors.js";
import { CRITERIA, DATA_FILE_FORMATS, FIND_CATEGORIES, LANGUAGES, MAX_PAGELENGTH } from "./params.js";

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

/**
 * Check the parameters of one GENESIS request before it is sent. `undefined`
 * and `null` mean "omitted" and are never sent. A parameter with its own rule
 * (`pagelength`, `timeslices`, `language`, `category`, the criteria, `format`, …) must pass it; every other string that is given must be
 * non-blank. Throws `RegionalstatistikValidationError` naming the parameter.
 */
export function assertRequestParams(params: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    // An own-property lookup, so a key such as "constructor" is never a rule.
    const rule = Object.prototype.hasOwnProperty.call(RULES, key) ? RULES[key] : undefined;
    if (rule !== undefined) assertValid(key, value, rule);
    else if (typeof value === "string") assertValid(key, value, nonBlankProblem);
  }
}
