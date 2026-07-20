// find service: full-text search across every GENESIS object type.

import { Option, type Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, commonListParams, parseNonEmpty, renderJson } from "../shared.js";
import type { FindCategory } from "../../client/params.js";

const CATEGORIES = ["all", "tables", "statistics", "cubes", "variables", "time-series"] as const;

export function registerFindCommand(program: Command, deps: CliDeps): void {
  program
    .command("find")
    .description(
      "Full-text search across statistics, tables, cubes, variables and time series " +
        '(e.g. `regstat find "bevölkerung kreise" --category tables`)',
    )
    .argument("<term>", "search term (must be non-empty)", parseNonEmpty)
    .addOption(
      new Option("--category <cat>", "restrict to an object type").choices([...CATEGORIES]).default("all"),
    )
    .action(
      action(deps, async ({ client, global, opts }, [term]) => {
        renderJson(
          deps,
          global,
          await client.find({
            term: term!,
            category: opts["category"] as FindCategory,
            ...commonListParams(global),
          }),
        );
      }),
    );
}
