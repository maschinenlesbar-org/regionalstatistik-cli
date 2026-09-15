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
import { parseIntArg, parseBoundedInt, parseHeaderValue, parseNonEmpty, parseBaseUrl } from "./shared.js";
import { RegionalstatistikUsageError } from "../client/errors.js";
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
 * Read a credential env var, trimmed, and validate it as an HTTP header value. A
 * missing, empty, or whitespace-only value is treated as unset (returns
 * undefined) so it never seeds a blank credential.
 *
 * Env values are seeded via setOptionValue, which does NOT run commander's
 * value-parsers, so an env credential otherwise skips the control-char check
 * that flag values get. Run it through parseHeaderValue here and re-raise a
 * control-char rejection as a typed usage error (exit 2) with a clean message,
 * instead of letting a CR/LF reach Node's HTTP layer as an opaque
 * ERR_INVALID_CHAR "Unexpected error".
 */
function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return parseHeaderValue(trimmed);
  } catch {
    throw new RegionalstatistikUsageError(`Environment variable ${name} contains control characters.`);
  }
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
    .option("--token <token>", "GENESIS API token (env: REGIONALSTATISTIK_API_TOKEN)", parseHeaderValue)
    .option(
      "--username <user>",
      "GENESIS account username (env: REGIONALSTATISTIK_USERNAME)",
      parseHeaderValue,
    )
    .option(
      "--password <pass>",
      "GENESIS account password (env: REGIONALSTATISTIK_PASSWORD)",
      parseHeaderValue,
    )
    .addOption(
      new Option("--language <lang>", "response language").choices(["de", "en"]).default("de"),
    )
    .option(
      "--pagelength <n>",
      "max list results for find/catalogue (1..25000; ignored by data/metadata)",
      parseBoundedInt(1, 25000),
    )
    .option(
      "--timeout <ms>",
      "time limit per request in ms, whole response included (0 = no timeout)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      "retries for transient 429/503 responses (0..10)",
      parseBoundedInt(0, 10),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option("-o, --output <file>", "write output (JSON, or a download) to this file", parseNonEmpty)
    .option("--force", "overwrite the --output file if it already exists")
    .showHelpAfterError();

  // Seed each credential flag from its env var (trimmed; blank treated as unset).
  // commander treats these as the option's value, which an explicit flag on the
  // command line overrides during parse: flag > env var > unset, per field.
  const env = deps.env ?? process.env;
  const tokenEnv = readEnv(env, "REGIONALSTATISTIK_API_TOKEN");
  const userEnv = readEnv(env, "REGIONALSTATISTIK_USERNAME");
  const passEnv = readEnv(env, "REGIONALSTATISTIK_PASSWORD");
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
