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
} from "../client/errors.js";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  try {
    // buildProgram is inside the try: seeding env credentials validates them and
    // may throw a RegionalstatistikUsageError, which must be caught and mapped to
    // the usage exit code rather than escaping as an uncaught rejection.
    const program = buildProgram(deps);
    configureTree(program, deps);
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version (and bare "no command", which prints help) use commander's
      // exitCode 0; every other commander error — bad option value, missing or
      // invalid argument, unknown option/command — is a usage error. Normalise
      // those to the conventional usage exit code 2 (matching
      // RegionalstatistikUsageError) so scripts get one reliable "usage problem"
      // signal instead of a mix of 1 and 2. See DEVELOPING.md's exit-code table.
      return err.exitCode === 0 ? 0 : 2;
    }
    if (err instanceof RegionalstatistikUsageError) {
      // Bad/missing arguments or credentials -> conventional usage exit code.
      deps.io.err(`Error: ${err.message}`);
      return 2;
    }
    if (err instanceof RegionalstatistikApiError) {
      deps.io.err(`Error: ${err.message}`);
      // GENESIS signals a credential failure as HTTP 401/403 and/or the logical
      // Code 15 in a flat JSON body (the engine extracts the code either way);
      // hint at the fix for both.
      if (err.isAuthError) {
        deps.io.err("Hint: check your credentials (--token or --username/--password).");
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
