// find service: full-text search across every GENESIS object type.

import { Option, type Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, commonListParams, parseNonEmpty, renderJson } from "../shared.js";
import { FIND_CATEGORIES, type FindCategory } from "../../client/params.js";

export function registerFindCommand(program: Command, deps: CliDeps): void {
  program
    .command("find")
    .description(
      "Full-text search across statistics, tables, cubes, variables and time series " +
        '(e.g. `regstat find "bevölkerung kreise" --category tables`)',
    )
    .argument("<term>", "search term (must be non-empty)", parseNonEmpty)
    .addOption(
      // No .default(): an omitted --category is not sent, exactly like the library,
      // and GENESIS searches every object type.
      new Option("--category <cat>", "restrict to an object type (server default: all)").choices([
        ...FIND_CATEGORIES,
      ]),
    )
    .action(
      action(deps, async ({ client, global, opts }, [term]) => {
        renderJson(
          deps,
          global,
          await client.find({
            term: term!,
            ...(opts["category"] !== undefined ? { category: opts["category"] as FindCategory } : {}),
            ...commonListParams(global),
          }),
        );
      }),
    );
}
