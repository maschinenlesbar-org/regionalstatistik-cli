// helloworld service: connectivity and credential checks.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson } from "../shared.js";

export function registerHelloCommands(program: Command, deps: CliDeps): void {
  program
    .command("hello")
    .description("Connectivity check (helloworld/whoami) — needs no credentials")
    .action(
      action(
        deps,
        async ({ client, global }) => {
          renderJson(deps, global, await client.whoami());
        },
        { auth: false },
      ),
    );

  program
    .command("logincheck")
    .description("Validate your credentials (helloworld/logincheck)")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.logincheck(global.language));
      }),
    );
}
