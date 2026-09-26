// Shared helpers used across CLI command groups: option parsers, credential
// resolution, the global-option -> client-option mapping, and the two
// result-rendering paths (JSON and raw download).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { RawResponse } from "../client/engine.js";
import type { RegionalstatistikClientOptions } from "../client/client.js";
import { RegionalstatistikUsageError } from "../client/errors.js";

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

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * commander value-parser for --base-url: accept only an absolute http/https URL,
 * and reject one carrying embedded userinfo (`https://user:pass@host`). Rejecting
 * at parse time yields the conventional usage exit code (2) instead of a later
 * runtime failure, and closes the only way credentials could end up in a URL —
 * so they cannot leak into an error message or become a Basic Authorization
 * header. GENESIS never uses Basic auth, so userinfo has no legitimate use here.
 */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Must be an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError('Only "http:" and "https:" URLs are allowed.');
  }
  if (url.username || url.password) {
    throw new InvalidArgumentError(
      "Must not embed credentials (user:pass@host). Use --token or --username/--password.",
    );
  }
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (credentials,
 * User-Agent). Node's HTTP layer throws an opaque "Invalid character in header
 * content" at request time for a CR/LF (or any other C0 control or DEL) and for
 * any character above U+00FF, which escaped our typed-error handling as
 * "Unexpected error". Reject those here as a usage error, along with a blank
 * value (a blank `--token ""` silently cancelled a valid env token). Tab (0x09)
 * and Latin-1 (e.g. "ü") are allowed — exactly what Node sends (as single
 * ISO-8859-1 bytes, not UTF-8). Checked by char code so the source stays free of
 * control bytes.
 */
export function parseHeaderValue(value: string): string {
  parseNonEmpty(value);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw new InvalidArgumentError("Value contains control characters.");
    }
    if (c > 0xff) {
      throw new InvalidArgumentError("Value contains characters outside Latin-1 (above U+00FF).");
    }
  }
  return value;
}

/**
 * commander value-parser for a credential (`--token`, `--username`, `--password`,
 * and the env vars): a valid header value (see parseHeaderValue) with no leading
 * or trailing whitespace. An HTTP header cannot carry those — the receiving
 * server strips them as optional whitespace — so a password such as
 * "  pass  " could never be sent as typed. Rejecting it beats silently
 * trimming it into a different password.
 */
export function parseCredential(value: string): string {
  parseHeaderValue(value);
  if (value !== value.trim()) {
    throw new InvalidArgumentError(
      "Value has leading or trailing whitespace, which an HTTP header cannot carry.",
    );
  }
  return value;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

export interface GlobalOptions {
  baseUrl?: string;
  token?: string;
  username?: string;
  password?: string;
  language?: string;
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
 * Supplying only one of username/password is a usage error (exit 2). No
 * credentials at all is allowed here — commands that need auth enforce presence
 * via {@link action}'s `auth` guard.
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
  if (username && password) return { username, password, present: true };
  if (username || password) {
    throw new RegionalstatistikUsageError(
      "Provide BOTH --username and --password (or use --token). " +
        "Env: REGIONALSTATISTIK_USERNAME + REGIONALSTATISTIK_PASSWORD, or REGIONALSTATISTIK_API_TOKEN.",
    );
  }
  return { present: false };
}

/** Translate resolved global CLI options + credentials into client options. */
export function toClientOptions(
  global: GlobalOptions,
  creds: ResolvedCredentials,
): RegionalstatistikClientOptions {
  const options: RegionalstatistikClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  const ua = nonBlank(global.userAgent);
  if (ua !== undefined) options.userAgent = ua;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  if (creds.token !== undefined) options.token = creds.token;
  if (creds.username !== undefined) options.username = creds.username;
  if (creds.password !== undefined) options.password = creds.password;
  return options;
}

/**
 * Write bytes to the --output file, guarding against an accidental overwrite and
 * wrapping raw filesystem errors in a typed usage error. Refuses to clobber an
 * existing file unless --force is set (fail-secure: no silent data loss), and
 * turns an ENOENT/EISDIR/EACCES from writeFile into a clean
 * RegionalstatistikUsageError instead of an untyped "Unexpected error: ENOENT: …".
 */
function writeOutputFile(deps: CliDeps, global: GlobalOptions, path: string, data: Buffer): void {
  if (!global.force && deps.io.fileExists(path)) {
    throw new RegionalstatistikUsageError(
      `Refusing to overwrite existing file "${path}". Pass --force to overwrite, or choose a different --output path.`,
    );
  }
  try {
    deps.io.writeFile(path, data);
  } catch (err) {
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
 * Render a JSON value, pretty by default and compact with --compact. Writes to
 * the file given by --output (with a short stderr confirmation so stdout stays
 * clean for piping), or to stdout otherwise.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  if (global.output) {
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
  if (global.output) {
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
  const check: Array<{ opt: string; env: string }> = [
    { opt: "token", env: "REGIONALSTATISTIK_API_TOKEN" },
    { opt: "username", env: "REGIONALSTATISTIK_USERNAME" },
    { opt: "password", env: "REGIONALSTATISTIK_PASSWORD" },
  ];
  for (const { opt, env } of check) {
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
 * Wrap an async command action with credential resolution, an optional auth
 * guard, and client construction. The callback receives a context (client +
 * resolved global options + this command's options) and the positional args.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 * Pass `{ auth: false }` for commands that do not need credentials (e.g. `hello`).
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
    const root = rootCommand(command);
    const creds = resolveCredentials(global, {
      token: root.getOptionValueSource("token") === "cli",
      username: root.getOptionValueSource("username") === "cli",
      password: root.getOptionValueSource("password") === "cli",
    });
    if (opts.auth !== false && !creds.present) {
      throw new RegionalstatistikUsageError(
        "This command needs credentials. Set --username/--password " +
          "(env REGIONALSTATISTIK_USERNAME / REGIONALSTATISTIK_PASSWORD) " +
          "or --token (env REGIONALSTATISTIK_API_TOKEN). " +
          "A free account is available at https://www.regionalstatistik.de/genesis/online.",
      );
    }
    if (creds.present) warnArgvCredentials(deps, command);
    const client = deps.createClient(toClientOptions(global, creds));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

/** Common list-request params derived from global options (language, pagelength). */
export function commonListParams(global: GlobalOptions): { language?: string; pagelength?: number } {
  const params: { language?: string; pagelength?: number } = {};
  if (global.language !== undefined) params.language = global.language;
  if (global.pagelength !== undefined) params.pagelength = global.pagelength;
  return params;
}
