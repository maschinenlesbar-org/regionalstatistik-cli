// metadata service: describe a single object's structure. Each subcommand takes
// a required object <name> and returns an opaque `Object`.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import type { RegionalstatistikClient } from "../../client/client.js";
import type { MetadataParams } from "../../client/params.js";
import { action, parseNonEmpty, renderJson } from "../shared.js";

type MetadataFn = (
  client: RegionalstatistikClient,
  name: string,
  params: MetadataParams,
) => Promise<unknown>;

const SUBS: { name: string; desc: string; run: MetadataFn }[] = [
  { name: "table", desc: "Describe a table (e.g. 12411-01-01-4)", run: (c, n, p) => c.metadata.table(n, p) },
  { name: "statistic", desc: "Describe a statistic (e.g. 12411)", run: (c, n, p) => c.metadata.statistic(n, p) },
  { name: "cube", desc: "Describe a data cube", run: (c, n, p) => c.metadata.cube(n, p) },
  { name: "timeseries", desc: "Describe a time series", run: (c, n, p) => c.metadata.timeseries(n, p) },
  { name: "variable", desc: "Describe a variable (e.g. KREISE)", run: (c, n, p) => c.metadata.variable(n, p) },
  { name: "value", desc: "Describe a variable value", run: (c, n, p) => c.metadata.value(n, p) },
];

export function registerMetadataCommands(program: Command, deps: CliDeps): void {
  const meta = program
    .command("metadata")
    .alias("meta")
    .description("Describe an object's structure (metadata) by its code");

  for (const sub of SUBS) {
    meta
      .command(sub.name)
      .description(sub.desc)
      .argument("<name>", "object code (must be non-empty)", parseNonEmpty)
      .option("--area <area>", "data area")
      .action(
        action(deps, async ({ client, global, opts }, [name]) => {
          const params: MetadataParams = {};
          if (global.language !== undefined) params.language = global.language;
          if (typeof opts["area"] === "string") params.area = opts["area"];
          renderJson(deps, global, await sub.run(client, name!, params));
        }),
      );
  }
}
