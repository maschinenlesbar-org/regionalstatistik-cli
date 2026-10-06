// Shared helpers used across CLI command groups: option parsers, credential
// resolution, the global-option -> client-option mapping, and the two
// result-rendering paths (JSON and raw download).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { cleartextProblem, DEFAULT_BASE_URL, type RawResponse } from "../client/engine.js";
import type { RegionalstatistikClientOptions } from "../client/client.js";
import {
  RegionalstatistikError,
  RegionalstatistikUsageError,
  RegionalstatistikValidationError,
} from "../client/errors.js";
import {
  BASE_URL_USERINFO_PROBLEM,
  baseUrlProblem,
  CREDENTIAL_PAIR_PROBLEM,
  credentialProblem,
  CREDENTIALS_REQUIRED_PROBLEM,
  headerValueProblem,
  intRangeProblem,
  nonBlankProblem,
  type Problem,
} from "../client/validate.js";
import type { Language } from "../client/params.js";

/**
 * commander value-parser: a non-negative integer in plain decimal notation.
 *
 * Deliberately strict — Number() would happily coerce "0x10" (16), "1e3" (1000),
 * "0b11" (3), whitespace-padded values, and "" / "  " (both 0). We only accept an
 * unpadded run of ASCII digits so the "non-negative integer" promise holds.
 */
export function parseIntArg(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** Throw the library's reason for an invalid value as a commander usage error. */
function check<T>(value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/** commander value-parser: a non-empty (after trimming) string — the library's rule. */
export function parseNonEmpty(value: string): string {
  return check(value, nonBlankProblem);
}

/**
 * commander value-parser for --base-url: the library's `baseUrlProblem` (an
 * absolute http/https URL without userinfo, query, fragment or whitespace).
 * Rejecting at parse time yields the conventional usage exit code (2); for an
 * embedded credential the CLI adds which flags to use instead.
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason === BASE_URL_USERINFO_PROBLEM) {
    throw new InvalidArgumentError(`${reason} Use --token or --username/--password.`);
  }
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (the
 * User-Agent): the library's `headerValueProblem` — non-blank, no control
 * characters (CR/LF included), nothing above U+00FF. Rejected here as a usage
 * error instead of Node's opaque "Invalid character in header content".
 */
export function parseHeaderValue(value: string): string {
  return check(value, headerValueProblem);
}

/**
 * commander value-parser for a credential (`--token`, `--username`,
 * `--password`, and the env vars): the library's `credentialProblem` — a valid
 * header value with no leading or trailing whitespace. A blank credential flag
 * is refused too (a blank `--token ""` silently cancelled a valid env token).
 */
export function parseCredential(value: string): string {
  return check(value, credentialProblem);
}

/**
 * Build the commander value-parser for a secret flag (`--token`, `--username`,
 * `--password`): the library's `credentialProblem`, like {@link parseCredential},
 * but a rejection never repeats the value. Commander words an `InvalidArgumentError`
 * as `option '--password <pass>' argument '<the value>' is invalid`, which put a
 * password pasted with a trailing space on stderr; this parser throws a
 * `RegionalstatistikUsageError` naming the flag and the reason only (exit 2 all the same).
 */
export function parseSecret(flags: string): (value: string) => string {
  return (value: string) => {
    const reason = credentialProblem(value);
    if (reason !== undefined) throw new RegionalstatistikUsageError(`option '${flags}' is invalid: ${reason}`);
    return value;
  };
}

/**
 * commander value-parser for `--password`: {@link parseSecret}, and a value that
 * starts with `--` is refused. Commander takes the next argument as the value of an
 * option that needs one, so `--password --compact logincheck` sent `--compact` as
 * the password: such a value is almost always a missing password that swallowed
 * the next option. The usage error names neither value and points to
 * `REGIONALSTATISTIK_PASSWORD` for a password that really starts with `--` (the
 * environment has no such ambiguity, and the library takes any password).
 */
export function parsePassword(flags: string): (value: string) => string {
  const secret = parseSecret(flags);
  return (value: string) => {
    if (value.startsWith("--")) {
      throw new RegionalstatistikUsageError(
        `option '${flags}' is invalid: the value starts with "--", so the password is probably missing ` +
          `and the next option was taken as the password. A password that really starts with "--" goes in ` +
          `${CREDENTIAL_ENV.password} instead.`,
      );
    }
    return secret(value);
  };
}

/**
 * Build a commander value-parser for an integer constrained to [min, max]: the
 * string is parsed here, the range is the library's rule (`intRangeProblem`).
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  const problem = intRangeProblem(min, max);
  return (value: string) => check(parseIntArg(value), problem);
}

export interface GlobalOptions {
  baseUrl?: string;
  token?: string;
  username?: string;
  password?: string;
  language?: Language;
  pagelength?: number;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
  force?: boolean;
}

/** A non-blank string option value, unchanged; undefined otherwise. */
function nonBlank(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Credentials resolved from the global options (flags already seeded from env). */
export interface ResolvedCredentials {
  token?: string;
  username?: string;
  password?: string;
  /** True when a usable credential (a token, or a username+password pair) is present. */
  present: boolean;
}

/** The env var behind each credential option. */
export const CREDENTIAL_ENV = {
  token: "REGIONALSTATISTIK_API_TOKEN",
  username: "REGIONALSTATISTIK_USERNAME",
  password: "REGIONALSTATISTIK_PASSWORD",
} as const;

/** Which credential options were given as flags on the command line (not seeded from env). */
export interface CredentialSources {
  token?: boolean;
  username?: boolean;
  password?: boolean;
}

/**
 * Resolve the credential flags into a normalized form. A token wins over
 * username/password — except that a `--username`/`--password` **flag** beats a
 * token that only came from `REGIONALSTATISTIK_API_TOKEN`: the account named on
 * the command line is the one the user means, so an env token must not silently
 * authenticate as someone else. (An explicit `--token` flag still wins.)
 * Precedence only: a lone username or password is passed on as is, and the
 * library's pair rule rejects it when the client is built (see {@link action}).
 * No credentials at all is allowed here — the library rejects an account-only
 * call without them, and {@link action} rewords that error.
 */
export function resolveCredentials(
  global: GlobalOptions,
  fromCli: CredentialSources = {},
): ResolvedCredentials {
  const pairFromCli = !fromCli.token && (fromCli.username === true || fromCli.password === true);
  const token = pairFromCli ? undefined : nonBlank(global.token);
  if (token) return { token, present: true };

  const username = nonBlank(global.username);
  const password = nonBlank(global.password);
  return {
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    present: username !== undefined && password !== undefined,
  };
}

/**
 * Build the client, rewording the library's credential-pair error with the
 * flags and env vars that supply the pair.
 */
function createClient(
  deps: CliDeps,
  options: RegionalstatistikClientOptions,
): ReturnType<CliDeps["createClient"]> {
  try {
    return deps.createClient(options);
  } catch (err) {
    if (err instanceof RegionalstatistikValidationError && err.message.endsWith(CREDENTIAL_PAIR_PROBLEM)) {
      throw new RegionalstatistikUsageError(
        "Provide BOTH --username and --password (or use --token). " +
          "Env: REGIONALSTATISTIK_USERNAME + REGIONALSTATISTIK_PASSWORD, or REGIONALSTATISTIK_API_TOKEN.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Translate resolved global CLI options + credentials into client options. */
export function toClientOptions(
  global: GlobalOptions,
  creds: ResolvedCredentials,
): RegionalstatistikClientOptions {
  const options: RegionalstatistikClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  if (creds.token !== undefined) options.token = creds.token;
  if (creds.username !== undefined) options.username = creds.username;
  if (creds.password !== undefined) options.password = creds.password;
  return options;
}

/** The usage error for an --output path that already exists (without --force). */
function refuseOverwrite(path: string): RegionalstatistikUsageError {
  return new RegionalstatistikUsageError(
    `Refusing to overwrite existing file "${path}". Pass --force to overwrite, or choose a different --output path.`,
  );
}

/**
 * Write bytes to the --output file, guarding against an accidental overwrite and
 * wrapping raw filesystem errors in a typed usage error. Refuses to clobber an
 * existing file — or to write through a symlink, dangling or not — unless --force
 * is set (fail-secure: no silent data loss), and turns an ENOENT/EISDIR/EACCES
 * from writeFile into a clean RegionalstatistikUsageError instead of an untyped
 * "Unexpected error: ENOENT: …". `action()` already refused an existing path
 * before the request; this re-check catches one that appeared meanwhile.
 */
function writeOutputFile(deps: CliDeps, global: GlobalOptions, path: string, data: Buffer): void {
  const force = global.force === true;
  if (!force && deps.io.fileExists(path)) throw refuseOverwrite(path);
  try {
    // Without --force the write is an exclusive create, so a symlink (even a
    // dangling one) or a file that appeared since the check is refused too.
    deps.io.writeFile(path, data, force);
  } catch (err) {
    if (!force && (err as NodeJS.ErrnoException | undefined)?.code === "EEXIST") throw refuseOverwrite(path);
    const reason = err instanceof Error ? err.message : String(err);
    throw new RegionalstatistikUsageError(`Could not write to "${path}": ${reason}`);
  }
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a
 * RegionalstatistikError so the CLI prints a clear message instead of
 * "Unexpected error: Maximum call stack size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new RegionalstatistikError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * True when --output names a file. `-o -` means stdout, as in other CLIs (P12): it used
 * to create a file named "-".
 */
function toFile(global: GlobalOptions): global is GlobalOptions & { output: string } {
  return typeof global.output === "string" && global.output !== "-";
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Writes to
 * the file given by --output (with a short stderr confirmation so stdout stays
 * clean for piping), or to stdout otherwise.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  if (toFile(global)) {
    const data = Buffer.from(text + "\n", "utf8");
    writeOutputFile(deps, global, global.output, data);
    deps.io.err(`Wrote ${data.length} bytes to ${global.output}`);
  } else {
    deps.io.out(text);
  }
}

/**
 * Render a raw (binary/text) download. Writes to the file given by --output, or
 * to stdout otherwise. Prints a short confirmation to stderr when writing a file
 * so stdout stays clean for piping. The confirmation reports the server's
 * Content-Type so the user can tell what the bytes actually are (e.g. a ZIP).
 */
export function renderRaw(deps: CliDeps, global: GlobalOptions, response: RawResponse): void {
  const typeNote = response.contentType ? ` (Content-Type: ${response.contentType})` : "";
  if (toFile(global)) {
    writeOutputFile(deps, global, global.output, response.data);
    deps.io.err(`Wrote ${response.data.length} bytes to ${global.output}${typeNote}`);
  } else {
    deps.io.outBinary(response.data);
    deps.io.err(`Wrote ${response.data.length} bytes to stdout${typeNote}`);
  }
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/** The root program: credential options and their sources live on it. */
function rootCommand(command: Command): Command {
  let c = command;
  while (c.parent) c = c.parent;
  return c;
}

/**
 * Warn (once, to stderr) when a credential arrived on the command line rather
 * than via its env var. Argv is visible in the process table (ps / /proc) and is
 * persisted in shell history, so a flag-supplied credential — especially the
 * account *password* — is exposed to other local users and to disk. The env var
 * is the preferred path (and takes effect whenever the flag is absent).
 *
 * commander records an explicit flag as source "cli"; an env value seeded via
 * setOptionValue has source undefined, so this fires only for the argv path and
 * never for the env path. The credential value itself is never printed.
 */
function warnArgvCredentials(deps: CliDeps, command: Command): void {
  const root = rootCommand(command);
  const flagged: string[] = [];
  for (const [opt, env] of Object.entries(CREDENTIAL_ENV)) {
    if (root.getOptionValueSource(opt) === "cli") flagged.push(`--${opt} (env ${env})`);
  }
  if (flagged.length > 0) {
    deps.io.err(
      `Warning: credential(s) passed on the command line are visible in the process ` +
        `list and shell history. Prefer the environment variable(s): ${flagged.join(", ")}.`,
    );
  }
}

/**
 * Say on stderr when a `--username`/`--password` flag set a token from
 * `REGIONALSTATISTIK_API_TOKEN` aside (see {@link resolveCredentials}): the run then
 * logs in with a username and password, or — with `--username` alone and no
 * password anywhere — fails with the pair error, and without this line the user
 * may not realise the token was not used. Names the flag and the variable, never a
 * value. Printed before the pair check, so it explains that error too.
 */
function noteEnvTokenSetAside(
  deps: CliDeps,
  global: GlobalOptions,
  fromCli: CredentialSources,
  creds: ResolvedCredentials,
): void {
  if (fromCli.token || nonBlank(global.token) === undefined || creds.token !== undefined) return;
  const flags = [fromCli.username ? "--username" : undefined, fromCli.password ? "--password" : undefined]
    .filter((f) => f !== undefined)
    .join(" and ");
  deps.io.err(
    `Note: the token from ${CREDENTIAL_ENV.token} is not used: ${flags} on the command line ` +
      "selects a username and password login (the other half may come from its environment variable).",
  );
}

/**
 * Warn (once, to stderr) when the base URL is plain `http:` to a host other than
 * loopback (the library's `cleartextProblem`): the requests, and with them the
 * token or the login when one is sent, travel unencrypted. The line names the host
 * and what is sent — "the token", "the login" — never a value. Called after the
 * client is built and before the first request, so `--help`, `--version` and a
 * parse-time usage error never warn; stdout and the exit code are untouched.
 */
function warnCleartext(deps: CliDeps, global: GlobalOptions, creds: ResolvedCredentials): void {
  const secrets = creds.token !== undefined ? ["the token"] : creds.present ? ["the login"] : [];
  const problem = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL, secrets);
  if (problem !== undefined) deps.io.err(`warning: ${problem}`);
}

/**
 * Validate the credentials about to be sent that came from an env var. A flag
 * value was already checked by its commander parser; an env value is seeded
 * unchecked (see program.ts readEnv) so that a malformed one only fails the run
 * that would actually send it — never `--help`, `--version`, `hello` or a run
 * whose flag overrides it. The rejection names the variable, never its value.
 */
function checkEnvCredentials(root: Command, creds: ResolvedCredentials): void {
  for (const key of ["token", "username", "password"] as const) {
    const value = creds[key];
    if (value === undefined || root.getOptionValueSource(key) === "cli") continue;
    try {
      parseCredential(value);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Value is not a valid header value.";
      throw new RegionalstatistikUsageError(reason.replace(/^Value/, `Environment variable ${CREDENTIAL_ENV[key]}`));
    }
  }
}

/**
 * Run a command body, rewording the library's "this endpoint needs an account"
 * error with the flags and env vars that supply credentials, and the signup URL.
 */
async function withCredentialsHint(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (err instanceof RegionalstatistikValidationError && err.message.endsWith(CREDENTIALS_REQUIRED_PROBLEM)) {
      throw new RegionalstatistikUsageError(
        "This command needs credentials. Set --username/--password " +
          "(env REGIONALSTATISTIK_USERNAME / REGIONALSTATISTIK_PASSWORD) " +
          "or --token (env REGIONALSTATISTIK_API_TOKEN). " +
          "A free account is available at https://www.regionalstatistik.de/genesis/online.",
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Wrap an async command action with credential resolution and client
 * construction. The callback receives a context (client + resolved global
 * options + this command's options) and the positional args. Which commands need
 * credentials is the library's rule: an account-only call rejects before any
 * request, and the error is reworded here with the flags and env vars
 * (`logincheck` without credentials answers as guest, like the library).
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 * Pass `{ auth: false }` for commands that take no credentials (e.g. `hello`):
 * the credential options are then ignored entirely and nothing is sent.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
  opts: { auth?: boolean } = {},
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // Refuse an existing --output file before any request, so the refusal costs no
    // download (and no wait up to --timeout). writeOutputFile checks again at write
    // time with an exclusive create, which also catches a file that appears meanwhile.
    if (toFile(global) && global.force !== true && deps.io.fileExists(global.output)) {
      throw refuseOverwrite(global.output);
    }
    // A command that takes no credentials (`hello`) never sends any, so they are
    // not resolved at all: a half-configured or malformed env login must not fail
    // the very connectivity check used to debug it.
    let creds: ResolvedCredentials = { present: false };
    if (opts.auth !== false) {
      const root = rootCommand(command);
      const fromCli: CredentialSources = {
        token: root.getOptionValueSource("token") === "cli",
        username: root.getOptionValueSource("username") === "cli",
        password: root.getOptionValueSource("password") === "cli",
      };
      creds = resolveCredentials(global, fromCli);
      noteEnvTokenSetAside(deps, global, fromCli, creds);
      checkEnvCredentials(root, creds);
    }
    // A half username/password pair gets the library's pair error, reworded.
    const client = createClient(deps, toClientOptions(global, creds));
    warnCleartext(deps, global, creds);
    if (creds.present) warnArgvCredentials(deps, command);
    await withCredentialsHint(() => fn({ client, global, opts: command.opts() }, positionals));
  };
}

/** Common list-request params derived from global options (language, pagelength). */
export function commonListParams(global: GlobalOptions): { language?: Language; pagelength?: number } {
  const params: { language?: Language; pagelength?: number } = {};
  if (global.language !== undefined) params.language = global.language;
  if (global.pagelength !== undefined) params.pagelength = global.pagelength;
  return params;
}
