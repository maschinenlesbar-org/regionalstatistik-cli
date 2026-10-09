// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import {
  RegionalstatistikApiError,
  RegionalstatistikError,
  RegionalstatistikNetworkError,
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
    // commander's own messages are log records too: its "error: …" an ERROR, the help it
    // shows after one an INFO.
    writeErr: (str) => {
      const text = str.replace(/\n$/, "");
      // The blank line commander writes between an error and the help it shows after.
      if (text === "") return;
      if (text.startsWith("error: ")) logOf(deps).error("cli", text.slice("error: ".length));
      else logOf(deps).info("cli", text);
    },
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

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /** stdout text: every secret of the run replaced (`***@`, `***`). */
  out(text: string): string;
  /** stderr text, a record's message: the same replacements as on stdout. */
  err(text: string): string;
  /**
   * Make `value` a secret of the run from now on, like a flag or env value: for a
   * credential the run learns after argv, one read from the credentials file.
   */
  addSecret(value: string): void;
}

/**
 * The secrets of the run in `argv` and `env`. Commander echoes rejected values in its
 * usage errors and names unknown commands and options as typed, and the server may echo
 * a credential back (`logincheck` returns the token as `Username`), so whatever path a
 * secret takes to the terminal it is replaced:
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
 * Both on stdout and on stderr: GENESIS echoes the token or user name as `Username` in
 * the data. A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or
 * `/`; the exact strings can. Without secrets the text passes through unchanged.
 * `addSecret` adds a secret later, for a credential that only `action()` learns — one
 * read from the credentials file (`regstat config`), which is in neither argv nor the
 * environment.
 */
export function redactionFor(argv: readonly string[], env: Record<string, string | undefined>): Redaction {
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
  const urlList = [...userinfo];
  const redact = (text: string): string => redactSecrets(redactCredentials(text, urlList), [...secrets]);
  return { out: redact, err: redact, addSecret };
}

/**
 * `deps` that keep the secrets of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the raw `io.err`, so the frame is never
 * touched. `io.err` itself is redacted too, for anything that writes to stderr without
 * the log. The returned `io.redact` adds secrets later (`Redaction.addSecret`): the
 * login read from the credentials file.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const redaction = redactionFor(argv, deps.env ?? process.env);
  const { out, err } = deps.io;
  return {
    ...deps,
    io: {
      ...deps.io,
      out: (text) => out(redaction.out(text)),
      err: (text) => err(redaction.err(text)),
      // A login read from the credentials file (`action()`) is kept out the same way.
      redact: (more) => {
        for (const value of more) redaction.addSecret(value);
      },
    },
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the secrets of the run in every message, in either format —
  // including a credential that `action()` adds later through `deps.redact`.
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
    const log = logOf(deps);
    if (err instanceof RegionalstatistikValidationError || err instanceof RegionalstatistikUsageError) {
      // Bad/missing arguments or credentials -> conventional usage exit code. A
      // RegionalstatistikValidationError is the library rejecting an input before
      // any request (it extends RegionalstatistikUsageError; named for clarity).
      log.error("cli", err.message);
      return 2;
    }
    if (err instanceof RegionalstatistikApiError) {
      log.error("api", err.message);
      // GENESIS signals a credential failure as HTTP 401/403 and/or a logical
      // code in a flat JSON body (15 = not authorized, 2 on a 404 = wrong
      // credentials; the engine extracts the code either way); hint at the fix.
      // The hint depends on what was sent: no hint at all for an endpoint that
      // takes no credentials (`hello` — a 401/403 there is a wrong --base-url or
      // a proxy, not a login problem).
      if (err.isAuthError && err.credentialsSent === true) {
        log.info("api", "check your credentials (--token or --username/--password, or the ones stored with `regstat config`).");
      } else if (err.isAuthError && err.credentialsSent === false) {
        log.info(
          "api",
          "GENESIS refused the request without credentials. Set --token (env REGIONALSTATISTIK_API_TOKEN) " +
            "or --username/--password (env REGIONALSTATISTIK_USERNAME / REGIONALSTATISTIK_PASSWORD), " +
            "or store them once with `regstat config set token` (or `username` and `password`).",
        );
      }
      // Map "object not found" (logical 90 / HTTP 404) to a distinct exit code.
      if (err.isNotFound) return 4;
      return 1;
    }
    if (err instanceof RegionalstatistikError) {
      log.error(err instanceof RegionalstatistikNetworkError ? "http" : "cli", err.message);
      return 1;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
