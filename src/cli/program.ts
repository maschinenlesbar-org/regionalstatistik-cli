// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { RegionalstatistikClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { MAX_RETRIES, MAX_RETRY_AFTER_MS } from "../client/engine.js";
import { LANGUAGES, MAX_PAGELENGTH } from "../client/params.js";
import {
  parseIntArg,
  parseBoundedInt,
  CREDENTIAL_ENV,
  parseHeaderValue,
  parsePassword,
  parseSecret,
  parseNonEmpty,
  parseBaseUrl,
} from "./shared.js";
import { registerHelloCommands } from "./commands/hello.js";
import { registerFindCommand } from "./commands/find.js";
import { registerCatalogueCommands } from "./commands/catalogue.js";
import { registerMetadataCommands } from "./commands/metadata.js";
import { registerDataCommands } from "./commands/data.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem + real env. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new RegionalstatistikClient(options),
  env: process.env,
};

/**
 * Read a credential env var. A missing, empty, or whitespace-only value is
 * treated as unset (returns undefined) so it never seeds a blank credential; any
 * other value is used exactly as set (never trimmed into a different credential).
 *
 * The value is NOT validated here: env values are seeded via setOptionValue,
 * which skips commander's value-parsers, and a malformed one must not break
 * `--help`, `--version`, `hello` or a run whose flag overrides it. `action()`
 * (shared.ts) checks an env credential with parseCredential only when the
 * command is about to send it, and names the variable — never its value.
 */
function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  if (raw.trim().length === 0) return undefined;
  return raw;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("regstat")
    .description(
      "CLI for the Regionaldatenbank Deutschland GENESIS REST API " +
        "(https://www.regionalstatistik.de) — official statistics of the Bund and " +
        "Länder down to Kreis and Gemeinde level. Needs a free account: pass " +
        "--username/--password (env REGIONALSTATISTIK_USERNAME / REGIONALSTATISTIK_PASSWORD) " +
        "or --token (env REGIONALSTATISTIK_API_TOKEN). Register at " +
        "https://www.regionalstatistik.de/genesis/online; `regstat hello` needs no credentials.",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", parseBaseUrl, "https://www.regionalstatistik.de")
    .option("--token <token>", "GENESIS API token (env: REGIONALSTATISTIK_API_TOKEN)", parseSecret("--token <token>"))
    .option("--username <user>", "GENESIS account username (env: REGIONALSTATISTIK_USERNAME)", parseSecret("--username <user>"))
    .option("--password <pass>", "GENESIS account password (env: REGIONALSTATISTIK_PASSWORD)", parsePassword("--password <pass>"))
    .addOption(
      // No .default(): an omitted --language is not sent, exactly like the library,
      // and GENESIS answers in German.
      new Option("--language <lang>", "response language (server default: de)").choices([...LANGUAGES]),
    )
    .option(
      "--pagelength <n>",
      `max list results for find/catalogue (1..${MAX_PAGELENGTH}; ignored by data/metadata)`,
      parseBoundedInt(1, MAX_PAGELENGTH),
    )
    .option(
      "--timeout <ms>",
      "time limit per request in ms, whole response included (0 = no timeout)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      `retries for transient 429/503 responses (0..${MAX_RETRIES}; each waits 200 ms × attempt or the server's longer Retry-After, up to ${MAX_RETRY_AFTER_MS / 1000} s)`,
      parseBoundedInt(0, MAX_RETRIES),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option("-o, --output <file>", "write output (JSON, or a download) to this file; `-` means stdout", parseNonEmpty)
    .option("--force", "overwrite the --output file if it already exists")
    .showHelpAfterError();

  // Seed each credential flag from its env var (blank treated as unset).
  // commander treats these as the option's value, which an explicit flag on the
  // command line overrides during parse: flag > env var > unset, per field.
  const env = deps.env ?? process.env;
  const tokenEnv = readEnv(env, CREDENTIAL_ENV.token);
  const userEnv = readEnv(env, CREDENTIAL_ENV.username);
  const passEnv = readEnv(env, CREDENTIAL_ENV.password);
  if (tokenEnv !== undefined) program.setOptionValue("token", tokenEnv);
  if (userEnv !== undefined) program.setOptionValue("username", userEnv);
  if (passEnv !== undefined) program.setOptionValue("password", passEnv);

  registerHelloCommands(program, deps);
  registerFindCommand(program, deps);
  registerCatalogueCommands(program, deps);
  registerMetadataCommands(program, deps);
  registerDataCommands(program, deps);

  return program;
}
