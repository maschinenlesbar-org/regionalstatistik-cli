// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { escapeControlChars } from "./shared.js";
import { OutputError, OutputRefusedError, logOf, type CliDeps } from "./io.js";
import { CredentialsFileError } from "./credentials.js";
import { DEFAULT_LOG_FORMAT, createLogger, logFormatFromArgv, type LogFormat, type Logger } from "./log.js";
import {
  RegionalstatistikApiError,
  RegionalstatistikError,
  RegionalstatistikNetworkError,
  RegionalstatistikParseError,
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
function configureTree(command: Command, deps: CliDeps, state: { errorLogged: boolean } = { errorLogged: false }): void {
  command.exitOverride();
  rejectRepeatedOptions(command);
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => writeCommanderErr(command, deps, state, str),
    outputError: (str, write) => write(withoutStrayValues(str)),
  });
  for (const child of command.commands) configureTree(child, deps, state);
}

/** `regstat config`: the command's name with its parents'. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/**
 * commander's stderr output as log records, one per line. Its `error: …` is an ERROR of
 * `cli`, with a following `(Did you mean …?)` line appended to that same record; the
 * help it shows after an error is one INFO record per non-blank line. A command group
 * run without its subcommand makes commander show the help as an error (exit 1, so 2
 * here) with no `error:` line: an ERROR record "missing command: `regstat catalogue
 * <subcommand>`" comes first, so every failed run has one.
 */
function writeCommanderErr(command: Command, deps: CliDeps, state: { errorLogged: boolean }, str: string): void {
  const log = logOf(deps);
  const text = str.replace(/\n$/, "");
  // The blank line commander writes between an error and the help it shows after.
  if (text.trim() === "") return;
  if (text.startsWith("error: ")) {
    state.errorLogged = true;
    log.error("cli", text.slice("error: ".length).replace(/\n(\(Did you mean .*\?\))$/, " $1"));
    return;
  }
  if (!state.errorLogged) {
    state.errorLogged = true;
    log.error("cli", `missing command: \`${commandPath(command)} <subcommand>\``);
  }
  for (const line of text.split("\n")) if (line.trim() !== "") log.info("cli", line.trimEnd());
}

/**
 * The names (long and short) of the program's own options that require a value
 * (`--user-agent`, `-o`). Only the program's: commander takes them out of argv wherever
 * they stand, before a subcommand sees the rest, so a subcommand's `--region-key` never
 * swallows a `--log-format` after it.
 */
function valueOptionsOf(program: Command): Set<string> {
  const names = new Set<string>();
  for (const option of program.options) {
    if (!option.required) continue;
    if (option.long !== undefined) names.add(option.long);
    if (option.short !== undefined) names.add(option.short);
  }
  return names;
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
/**
 * The options whose value is the base URL: a `user:password@host` given there without
 * its scheme is still a credential (anywhere else a bare `a:b@c` is not).
 */
const BASE_URL_FLAGS = ["--base-url"];

/** The values of the `flags` in `argv`, in both forms (`--flag value`, `--flag=value`). */
function flagValues(argv: readonly string[], flags: readonly string[]): string[] {
  const found: string[] = [];
  argv.forEach((token, i) => {
    const next = argv[i + 1];
    if (flags.includes(token) && next !== undefined) found.push(next);
    const eq = token.indexOf("=");
    if (eq > 0 && flags.includes(token.slice(0, eq))) found.push(token.slice(eq + 1));
  });
  return found;
}

/** The environment variables that hold a secret on their own. */
const SECRET_ENVS = ["REGIONALSTATISTIK_API_TOKEN", "REGIONALSTATISTIK_USERNAME", "REGIONALSTATISTIK_PASSWORD"];

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /**
   * stdout text: the userinfo of a URL (`***@`), and a bare secret only where it is a
   * whole JSON string value (`"Username": "***"`), never inside other text — a password
   * `2023` turned every year 2023 in a table into `***` (destatis-genesis 03-1).
   */
  out(text: string): string;
  /** stderr text, a record's message: the userinfo and every bare secret of the run (`***`). */
  err(text: string): string;
  /**
   * Make `value` a secret of the run from now on, like a flag or env value: for a
   * credential the run learns after argv, one read from the credentials file.
   */
  addSecret(value: string): void;
}

/**
 * `text` with every JSON string literal whose content is one of `secrets` (in the form
 * stdout prints it: JSON-escaped, DEL and C1 as `\u00XX`) replaced by `"***"`. Only whole
 * values: a secret inside a longer string is data and stays (destatis-genesis 03-1). A
 * non-JSON text has no string literals to match and passes through unchanged.
 */
function redactWholeJsonValues(text: string, secrets: ReadonlySet<string>): string {
  if (secrets.size === 0) return text;
  return text.replace(/"((?:[^"\\]|\\.)*)"/g, (literal, content: string) =>
    content.trim().length >= 4 && secrets.has(content) ? '"***"' : literal,
  );
}

/**
 * The secrets of the run in `argv` and `env`. Commander echoes rejected values in its
 * usage errors and names unknown commands and options as typed, and the server may echo
 * a credential back (`logincheck` returns the token as `Username`), so whatever path a
 * secret takes to the terminal it is replaced:
 *
 * - the userinfo of every URL argument and `--opt=value` value (as `credentialsIn`
 *   finds it, parseable or not: only a value with a scheme, since a bare `a:b@c` is a
 *   file name, a search text or a User-Agent as often as a credential) and of the
 *   `--base-url` value (with or without a scheme) becomes `***@` — `--base-url`
 *   rejects userinfo, but the rejection must not print it;
 * - the values of `--token`, `--username` and `--password` (both forms), of
 *   `REGIONALSTATISTIK_API_TOKEN`, `REGIONALSTATISTIK_USERNAME` and `REGIONALSTATISTIK_PASSWORD`, and any
 *   argument shaped like a GENESIS token (`looksLikeToken`: a token typed without
 *   `--token`) become `***` — whole values, as given and trimmed, plus their
 *   JSON-escaped forms (also as stdout prints DEL and C1, `\u0085`) and URL-encoded
 *   forms (the forms a server echoes them back in, the ones the library scrubs from
 *   its errors); values under 4 characters are skipped
 *   (`redactSecrets`).
 *
 * The userinfo is replaced on stdout and stderr alike. A bare secret is replaced anywhere
 * on stderr (the log, and anything else written there), but on stdout only where it is a
 * whole JSON string value: `logincheck` returns the token or user name as `Username`,
 * and that stays hidden, while a short password such as `2023` no longer turns the year
 * in `"Statistik 2023"` into `***` (destatis-genesis 03-1). A pattern alone can't
 * delimit a password with spaces, quotes, `#`, `?` or `/`; the exact strings can. Without secrets the text passes through unchanged.
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
  // A base URL typed without its scheme is read as if it had one.
  const baseUrls = flagValues(argv, BASE_URL_FLAGS).map((value) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`));
  for (const source of [...values, ...baseUrls]) {
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
      // stdout's JSON escapes DEL and C1 after JSON.stringify (`escapeControlChars`):
      // a password with U+0085 is printed as `pass\u0085word` there.
      secrets.add(escapeControlChars(JSON.stringify(form).slice(1, -1)));
      // What a server echoes back URL-encoded (`pw=s3cret%2Bp%40ss`): the forms the
      // library scrubs from its errors, so a success answer is covered too.
      secrets.add(encodeURIComponent(form));
      // Form-encoded, as an `application/x-www-form-urlencoded` echo writes a space: `+`.
      secrets.add(encodeURIComponent(form).replace(/%20/g, "+"));
    }
  };
  for (const name of SECRET_ENVS) addSecret(env[name]);
  for (const value of flagValues(argv, SECRET_FLAGS)) addSecret(value);
  for (const value of values) if (looksLikeToken(value)) addSecret(value);
  const urlList = [...userinfo];
  const userinfoOnly = (text: string): string => redactCredentials(text, urlList);
  return {
    out: (text) => redactWholeJsonValues(userinfoOnly(text), secrets),
    err: (text) => redactSecrets(userinfoOnly(text), [...secrets]),
    addSecret,
  };
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
      // `config get --reveal`: the value as stored, not as the run's redaction makes it.
      outRaw: deps.io.outRaw ?? out,
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

/**
 * The log for what happens outside `run()`, in the bin shim: a stdout write error
 * (`handleOutputErrors`) and a rejection of `run()` itself. Its format is the one argv
 * asks for (`logFormatFromArgv`), and it replaces the secrets of argv and `env` like the
 * run's own log; it writes to the raw stderr.
 */
export function processLogger(argv: readonly string[], env: Record<string, string | undefined> = process.env): Logger {
  return createLogger({
    format: logFormatFromArgv(argv),
    write: (line) => process.stderr.write(line + "\n"),
    redact: redactionFor(argv, env).err,
  });
}

/**
 * The log area of a `RegionalstatistikError` that is neither an API error nor a usage
 * error: the connection (`http`), a malformed answer (`api`: bad JSON, the wrong shape,
 * an empty body, an unknown charset, an HTML page instead of a file, a login check that
 * confirms nothing — the API's answer as much as an error status is), the `-o` file
 * (`output`), the credentials file (`config`, like its successes), else `cli`.
 */
function areaOf(err: RegionalstatistikError): string {
  if (err instanceof RegionalstatistikNetworkError) return "http";
  if (err instanceof RegionalstatistikParseError) return "api";
  if (err instanceof OutputError) return "output";
  if (err instanceof CredentialsFileError) return "config";
  return "cli";
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
    // For the records of a parse error: the scan of argv, now knowing which of the
    // program's options take a value, as commander reads them.
    const log = deps.log;
    if (log !== undefined) log.format = logFormatFromArgv(argv, valueOptionsOf(program));
    // One source for the format once commander has parsed argv: its value, not the scan
    // of argv (an option's value can look like --log-format; `--` ends the scan, not
    // commander's parse of a value). Ancestors' hooks run first, so this precedes every
    // other preAction check.
    program.hook("preAction", (_program, actionCommand) => {
      const format = (actionCommand.optsWithGlobals() as { logFormat?: LogFormat }).logFormat;
      if (log !== undefined) log.format = format ?? DEFAULT_LOG_FORMAT;
    });
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
      // RegionalstatistikValidationError is the library rejecting an input before any
      // request (it extends RegionalstatistikUsageError; named here for clarity). An
      // existing -o file is a usage error too, logged in the area of the -o file.
      log.error(err instanceof OutputRefusedError ? "output" : "cli", err.message);
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
      log.error(areaOf(err), err.message);
      return 1;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
