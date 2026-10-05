// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  RegionalstatistikApiError,
  RegionalstatistikError,
  RegionalstatistikUsageError,
  RegionalstatistikValidationError,
  credentialsIn,
  redactCredentials,
  redactSecrets,
} from "../client/errors.js";
import { looksLikeToken } from "../client/validate.js";

/**
 * Commander's usage errors repeat what the user typed. Where that may be a secret
 * typed in the wrong place, say what went wrong without the value:
 *
 * - `too many arguments for 'x'. Expected 0 arguments but got 1: <values>.` loses
 *   the values (a password typed without `--password` ends up there);
 * - `unknown option '--tokn=<value>'` keeps the option name, not the value;
 * - `unknown command '<value>'` shows the value only when it reads like a command
 *   name (lower-case letters and hyphens), so a token or password typed without its
 *   flag is not echoed while a typo such as `serach` still is.
 */
export function withoutStrayValues(message: string): string {
  return message
    .replace(/^(error: too many arguments for '[^']*'\. Expected \d+ arguments? but got \d+): [\s\S]*?\.(\n|$)/, "$1.$2")
    .replace(/^(error: unknown option '-[^=']*=)[\s\S]*?'(\n|$)/, "$1…'$2")
    .replace(/^error: unknown command '([\s\S]*?)'(\n|$)/, (whole, value: string, end: string) =>
      /^[a-z][a-z-]{0,39}$/.test(value) ? whole : `error: unknown command (not shown: it is not a command name)${end}`,
    );
}

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  rejectRepeatedOptions(command);
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
    outputError: (str, write) => write(withoutStrayValues(str)),
  });
  for (const child of command.commands) configureTree(child, deps);
}

/**
 * Make a repeated single-value option a usage error (P10). Commander keeps the last
 * value of `--start-year 2020 --start-year 2021` without a word, so a script that
 * builds its argv from two sources silently gets one of them. Every option of
 * `command` that takes a value counts its occurrences (commander emits
 * `option:<name>` once per occurrence) and the second one throws — naming the
 * option, never the value.
 */
function rejectRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if (!(option.required || option.optional) || option.variadic) continue;
    let seen = 0;
    command.on(`option:${option.name()}`, () => {
      seen += 1;
      if (seen > 1) {
        throw new RegionalstatistikUsageError(`option '${option.flags}' was given more than once; it takes one value.`);
      }
    });
  }
}

/** The options whose value is a secret on its own (no `@` to anchor a redaction on). */
const SECRET_FLAGS = ["--token", "--username", "--password"];
/** The environment variables that hold a secret on their own. */
const SECRET_ENVS = ["REGIONALSTATISTIK_API_TOKEN", "REGIONALSTATISTIK_USERNAME", "REGIONALSTATISTIK_PASSWORD"];

/**
 * `deps` with an `io` that keeps the secrets of this run out of everything it prints,
 * on stdout and stderr. Commander echoes rejected values in its usage errors and
 * names unknown commands and options as typed, and the server may echo a credential
 * back (`logincheck` returns the token as `Username`), so whatever path a secret
 * takes to the terminal it is replaced:
 *
 * - the userinfo of every URL-like argument and `--opt=value` value (as
 *   `credentialsIn` finds it, parseable or not) becomes `***@` — `--base-url`
 *   rejects userinfo, but the rejection must not print it;
 * - the values of `--token`, `--username` and `--password` (both forms), of
 *   `REGIONALSTATISTIK_API_TOKEN`, `REGIONALSTATISTIK_USERNAME` and `REGIONALSTATISTIK_PASSWORD`, and any
 *   argument shaped like a GENESIS token (`looksLikeToken`: a token typed without
 *   `--token`) become `***` — whole values, as given and trimmed, plus their
 *   JSON-escaped forms; values under 4 characters are skipped (`redactSecrets`).
 *
 * A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the
 * exact strings can. Without secrets the output passes through unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const env = deps.env ?? process.env;
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const userinfo = new Set<string>();
  for (const source of [...argv, ...values]) {
    for (const secret of credentialsIn(source)) {
      userinfo.add(secret);
      userinfo.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  const secrets = new Set<string>();
  const addSecret = (value: string | undefined): void => {
    if (value === undefined) return;
    for (const form of [value, value.trim()]) {
      secrets.add(form);
      secrets.add(JSON.stringify(form).slice(1, -1));
    }
  };
  for (const name of SECRET_ENVS) addSecret(env[name]);
  argv.forEach((token, i) => {
    if (SECRET_FLAGS.includes(token)) addSecret(argv[i + 1]);
    const eq = token.indexOf("=");
    if (eq > 0 && SECRET_FLAGS.includes(token.slice(0, eq))) addSecret(token.slice(eq + 1));
  });
  for (const value of values) if (looksLikeToken(value)) addSecret(value);
  if (userinfo.size === 0 && [...secrets].every((s) => s.trim().length < 4)) return deps;
  const urlList = [...userinfo];
  const secretList = [...secrets];
  const redact = (text: string): string => redactSecrets(redactCredentials(text, urlList), secretList);
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) },
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  try {
    // buildProgram is inside the try so that anything it throws is mapped to an
    // exit code rather than escaping as an uncaught rejection. (Env credentials
    // are validated later, in action(), only when a command sends them.)
    const program = buildProgram(deps);
    configureTree(program, deps);
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help, `help` and --version use commander's exitCode 0. Every other
      // commander error — bad option value, missing or invalid argument, unknown
      // option/command, and no command at all (bare `regstat` or `regstat data`,
      // which print the help to stderr with commander's exitCode 1) — is a usage
      // error. Normalise those to the conventional usage exit code 2 (matching
      // RegionalstatistikUsageError) so scripts get one reliable "usage problem"
      // signal instead of a mix of 1 and 2. See Usage.md's exit-code table.
      return err.exitCode === 0 ? 0 : 2;
    }
    if (err instanceof RegionalstatistikValidationError || err instanceof RegionalstatistikUsageError) {
      // Bad/missing arguments or credentials -> conventional usage exit code. A
      // RegionalstatistikValidationError is the library rejecting an input before
      // any request (it extends RegionalstatistikUsageError; named for clarity).
      deps.io.err(`Error: ${err.message}`);
      return 2;
    }
    if (err instanceof RegionalstatistikApiError) {
      deps.io.err(`Error: ${err.message}`);
      // GENESIS signals a credential failure as HTTP 401/403 and/or a logical
      // code in a flat JSON body (15 = not authorized, 2 on a 404 = wrong
      // credentials; the engine extracts the code either way); hint at the fix.
      // The hint depends on what was sent: no hint at all for an endpoint that
      // takes no credentials (`hello` — a 401/403 there is a wrong --base-url or
      // a proxy, not a login problem).
      if (err.isAuthError && err.credentialsSent === true) {
        deps.io.err("Hint: check your credentials (--token or --username/--password).");
      } else if (err.isAuthError && err.credentialsSent === false) {
        deps.io.err(
          "Hint: GENESIS refused the request without credentials. Set --token (env REGIONALSTATISTIK_API_TOKEN) " +
            "or --username/--password (env REGIONALSTATISTIK_USERNAME / REGIONALSTATISTIK_PASSWORD).",
        );
      }
      // Map "object not found" (logical 90 / HTTP 404) to a distinct exit code.
      if (err.isNotFound) return 4;
      return 1;
    }
    if (err instanceof RegionalstatistikError) {
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
