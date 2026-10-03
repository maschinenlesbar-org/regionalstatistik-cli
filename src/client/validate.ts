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
 * Check the parameters of one GENESIS request before it is sent. `undefined`
 * and `null` mean "omitted" and are never sent; every string that is given must
 * be non-blank. Throws `RegionalstatistikValidationError` naming the parameter.
 */
export function assertRequestParams(params: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") assertValid(key, value, nonBlankProblem);
  }
}
