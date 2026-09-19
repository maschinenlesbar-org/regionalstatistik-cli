// catalogue service: browse GENESIS objects (tables, statistics, cubes, ...) by
// code selection. Every subcommand shares the same optional [selection] and
// filter options and returns an enveloped `List`.

import { Option, type Command } from "commander";
import type { CliDeps } from "../io.js";
import type { RegionalstatistikClient } from "../../client/client.js";
import type { CatalogueParams } from "../../client/params.js";
import { action, commonListParams, parseNonEmpty, renderJson } from "../shared.js";

type CatalogueFn = (client: RegionalstatistikClient, params: CatalogueParams) => Promise<unknown>;

const SUBS: { name: string; desc: string; run: CatalogueFn }[] = [
  { name: "tables", desc: "List tables (Tabellen)", run: (c, p) => c.catalogue.tables(p) },
  { name: "statistics", desc: "List statistics (Statistiken)", run: (c, p) => c.catalogue.statistics(p) },
  { name: "cubes", desc: "List data cubes (Datenquader)", run: (c, p) => c.catalogue.cubes(p) },
  { name: "timeseries", desc: "List time series (Zeitreihen)", run: (c, p) => c.catalogue.timeseries(p) },
  { name: "variables", desc: "List variables (Merkmale)", run: (c, p) => c.catalogue.variables(p) },
  { name: "values", desc: "List variable values (Ausprägungen)", run: (c, p) => c.catalogue.values(p) },
  { name: "terms", desc: "List search terms (Begriffe)", run: (c, p) => c.catalogue.terms(p) },
  { name: "jobs", desc: "List background jobs (Aufträge)", run: (c, p) => c.catalogue.jobs(p) },
  { name: "modified", desc: "List recently modified objects", run: (c, p) => c.catalogue.modifiedData(p) },
  { name: "results", desc: "List saved result tables (Ergebnistabellen)", run: (c, p) => c.catalogue.results(p) },
  { name: "qualitysigns", desc: "List quality-sign symbols", run: (c, p) => c.catalogue.qualitySigns(p) },
];

function buildParams(
  opts: Record<string, unknown>,
  selection: string | undefined,
  global: Parameters<typeof commonListParams>[0],
): CatalogueParams {
  const params: CatalogueParams = { ...commonListParams(global) };
  if (selection !== undefined) params.selection = selection;
  if (typeof opts["area"] === "string") params.area = opts["area"];
  if (typeof opts["searchCriterion"] === "string") {
    params.searchcriterion = opts["searchCriterion"] as CatalogueParams["searchcriterion"];
  }
  if (typeof opts["sortCriterion"] === "string") {
    params.sortcriterion = opts["sortCriterion"] as CatalogueParams["sortcriterion"];
  }
  if (typeof opts["type"] === "string") params.type = opts["type"];
  return params;
}

export function registerCatalogueCommands(program: Command, deps: CliDeps): void {
  const cat = program
    .command("catalogue")
    .alias("cat")
    .description("Browse the catalogue: list objects by code selection (e.g. `12411*`)");

  for (const sub of SUBS) {
    cat
      .command(sub.name)
      .description(sub.desc)
      .argument("[selection]", "code selection, `*` wildcard ok (e.g. `12411*`)", parseNonEmpty)
      .option("--area <area>", "data area (default server-side; try `all`)", parseNonEmpty)
      .addOption(
        new Option("--search-criterion <c>", "field `selection` matches").choices(["Code", "Content"]),
      )
      .addOption(new Option("--sort-criterion <c>", "result sort order").choices(["Code", "Content"]))
      .option("--type <type>", "object subtype filter", parseNonEmpty)
      .action(
        action(deps, async ({ client, global, opts }, [selection]) => {
          renderJson(deps, global, await sub.run(client, buildParams(opts, selection, global)));
        }),
      );
  }
}
