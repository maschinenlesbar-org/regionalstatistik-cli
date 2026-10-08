// `regstat config` — the GENESIS login kept in a credentials file of its own, the same
// mechanism as openka-cli's `ka config` and dip-bundestag-cli's `dip config`. A value
// goes in through a prompt without echo or through stdin, never as an argument, so it
// reaches neither shell history nor `ps`; it comes out masked unless asked for in full.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { RegionalstatistikError, RegionalstatistikUsageError } from "../../client/errors.js";
import { credentialProblem } from "../../client/validate.js";
import { CONFIG_DIR_NAME, credentialValueProblem, maskCredential, type CredentialStore } from "../credentials.js";
import type { CliDeps } from "../io.js";
import { CREDENTIAL_NAMES } from "../shared.js";

/** commander value-parser: a credential this program knows. */
function parseCredentialName(value: string): string {
  if (!(CREDENTIAL_NAMES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Not a credential: expected ${CREDENTIAL_NAMES.join(", ")}.`);
  }
  return value;
}

/**
 * Why `value` cannot be stored, or undefined: the store's rule (not blank, no control
 * character) and the library's `credentialProblem` (Latin-1, no leading or trailing
 * whitespace) — exactly what a token, username or password may be when it is sent.
 * Spaces inside are allowed: a password may hold them.
 */
function valueProblem(value: string): string | undefined {
  return credentialValueProblem(value) ?? credentialProblem(value);
}

/**
 * How a stored value is shown without --reveal. A token (32 characters) and a username
 * show their ends (`abcd…wxyz`); a password shows nothing of itself — it is short and
 * guessable, and eight of its characters would give most of it away.
 */
function masked(name: string, value: string): string {
  return name === "password" ? "****" : maskCredential(value);
}

function storeOf(deps: CliDeps): CredentialStore {
  if (deps.credentials === undefined) throw new RegionalstatistikError("This program was built without a credentials file.");
  return deps.credentials();
}

export function registerConfigCommands(program: Command, deps: CliDeps): void {
  const names = CREDENTIAL_NAMES.join(", ");
  const config = program
    .command("config")
    .description(
      `the GENESIS login, kept in a credentials file of its own: $XDG_CONFIG_HOME/${CONFIG_DIR_NAME}/credentials, ` +
        `else ~/.config/${CONFIG_DIR_NAME}/credentials (${names}); used when no flag or environment variable gives any credential`,
    );

  config
    .command("set")
    .description(
      "store a credential: typed at a prompt without echo, or piped in (printf %s \"$TOKEN\" | regstat config set token) — never given as an argument",
    )
    .argument("<name>", names, parseCredentialName)
    // Commander's own "too many arguments" error repeats them — here, the secret.
    .allowExcessArguments(true)
    .action(async (name: string, _options: unknown, command: Command) => {
      if (command.args.length > 1) {
        throw new RegionalstatistikUsageError(
          "regstat config set takes the name only: the value is read from a prompt or from stdin, never from the command line. " +
            "The one given is now in your shell history; if it is a secret, replace it there.",
        );
      }
      if (deps.io.readSecret === undefined) {
        throw new RegionalstatistikUsageError("No way to read a secret here: pipe it in, or run regstat config set on a terminal.");
      }
      // Only the line ends go: a value with spaces around it is refused, not trimmed
      // into another password.
      const value = (await deps.io.readSecret(`${name}: `)).replace(/[\r\n]+$/, "");
      const reason = valueProblem(value);
      if (reason !== undefined) throw new RegionalstatistikUsageError(`${reason} Nothing was stored.`);
      const store = storeOf(deps);
      store.set(name, value);
      deps.io.err(`Stored ${name} (${masked(name, value)}) in ${store.path}.`);
    });

  config
    .command("get")
    .description("show a stored credential, masked (abcd…wxyz; a password as ****) unless --reveal")
    .argument("<name>", names, parseCredentialName)
    .option("--reveal", "print the whole value, for a script that passes it on — it then is on your screen or in its log")
    .action(async (name: string, options: { reveal?: boolean }) => {
      const store = storeOf(deps);
      const value = store.get(name);
      if (value === undefined) throw new RegionalstatistikError(`No ${name} is stored in ${store.path}; regstat config set ${name} stores one.`);
      deps.io.out(options.reveal === true ? value : masked(name, value));
    });

  config
    .command("unset")
    .description("remove a stored credential")
    .argument("<name>", names, parseCredentialName)
    .action(async (name: string) => {
      const store = storeOf(deps);
      if (!store.unset(name)) throw new RegionalstatistikError(`No ${name} is stored in ${store.path}.`);
      deps.io.err(`Removed ${name} from ${store.path}.`);
    });

  config
    .command("list")
    .description("every stored credential, masked, and where the file is")
    .action(async () => {
      const store = storeOf(deps);
      const all = store.all();
      for (const name of Object.keys(all).sort()) deps.io.out(`${name}  ${masked(name, all[name] as string)}`);
      deps.io.err(`Credentials file: ${store.path}`);
    });
}
