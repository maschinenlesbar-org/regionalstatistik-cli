// data service: retrieve statistical data. JSON commands return the table as a
// delimited CSV string inside `Object.Content`; `*file` commands stream the
// server-rendered download (a ZIP wrapper) to --output or stdout.
//
// The regional filters are the point of this database: `--region-var` picks the
// regional level (e.g. KREISE, GEMEIN) and `--region-key` selects regions by
// their official AGS/ARS key (`*` wildcard ok — `08*` is every Kreis in
// Baden-Württemberg, `08221` is Stadtkreis Heidelberg).

import { Option, type Command } from "commander";
import type { CliDeps } from "../io.js";
import type { RegionalstatistikClient } from "../../client/client.js";
import type { RawResponse } from "../../client/engine.js";
import type { DataFileParams, DataFileFormat, DataTableParams } from "../../client/params.js";
import { action, parseIntArg, parseNonEmpty, renderJson, renderRaw } from "../shared.js";
import type { GlobalOptions } from "../shared.js";

const FORMATS = ["datencsv", "csv", "ffcsv", "xlsx", "html", "genml"] as const;

type JsonFn = (c: RegionalstatistikClient, name: string, p: DataTableParams) => Promise<unknown>;
type FileFn = (c: RegionalstatistikClient, name: string, p: DataFileParams) => Promise<RawResponse>;

const JSON_SUBS: { name: string; desc: string; run: JsonFn }[] = [
  { name: "table", desc: "Fetch a table's data (data/table) — CSV in Object.Content", run: (c, n, p) => c.data.table(n, p) },
  { name: "cube", desc: "Fetch a data cube (data/cube)", run: (c, n, p) => c.data.cube(n, p) },
  { name: "timeseries", desc: "Fetch a time series (data/timeseries)", run: (c, n, p) => c.data.timeseries(n, p) },
  { name: "result", desc: "Fetch a saved result table (data/result)", run: (c, n, p) => c.data.result(n, p) },
];

const FILE_SUBS: { name: string; desc: string; run: FileFn }[] = [
  { name: "tablefile", desc: "Download a table as a file (ZIP) — use -o <file>", run: (c, n, p) => c.data.tableFile(n, p) },
  { name: "cubefile", desc: "Download a cube as a file (ZIP) — use -o <file>", run: (c, n, p) => c.data.cubeFile(n, p) },
  { name: "timeseriesfile", desc: "Download a time series as a file (ZIP) — use -o <file>", run: (c, n, p) => c.data.timeseriesFile(n, p) },
  { name: "resultfile", desc: "Download a saved result as a file (ZIP) — use -o <file>", run: (c, n, p) => c.data.resultFile(n, p) },
];

/** Add the shared data-selection filter options to a command. */
function addDataOptions(cmd: Command): Command {
  cmd
    .option("--area <area>", "data area", parseNonEmpty)
    .option("--start-year <year>", "earliest year (YYYY)", parseNonEmpty)
    .option("--end-year <year>", "latest year (YYYY)", parseNonEmpty)
    .option("--timeslices <n>", "number of time slices from the end", parseIntArg)
    .option("--region-var <code>", "regional level variable (e.g. KREISE, GEMEIN)", parseNonEmpty)
    .option("--region-key <key>", "regional key: AGS/ARS code(s), `*` wildcard ok (e.g. `08*`, `08221`)", parseNonEmpty)
    .option("--contents <labels>", "restrict to these value labels (comma-separated)", parseNonEmpty)
    .option("--stand <date>", "only data newer than this date (DD.MM.YYYY)", parseNonEmpty)
    .option("--structure", "include the dimension structure tree")
    .option("--transpose", "transpose rows and columns")
    .option("--compress", "compress repeated labels");
  for (let i = 1; i <= 5; i++) {
    cmd
      .option(`--class-var${i} <code>`, `classifying variable ${i} code`, parseNonEmpty)
      .option(`--class-key${i} <key>`, `classifying key ${i} (value selection)`, parseNonEmpty);
  }
  return cmd;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Build the data-selection params from parsed options + global language. */
function buildDataParams(opts: Record<string, unknown>, global: GlobalOptions): DataTableParams {
  const p: Record<string, string | number | boolean> = {};
  if (global.language !== undefined) p["language"] = global.language;

  const map: Record<string, string> = {
    area: "area",
    startYear: "startyear",
    endYear: "endyear",
    regionVar: "regionalvariable",
    regionKey: "regionalkey",
    contents: "contents",
    stand: "stand",
  };
  for (const [optKey, paramKey] of Object.entries(map)) {
    const v = str(opts[optKey]);
    if (v !== undefined) p[paramKey] = v;
  }
  if (typeof opts["timeslices"] === "number") p["timeslices"] = opts["timeslices"];
  if (opts["structure"] === true) p["structureinformation"] = true;
  if (opts["transpose"] === true) p["transpose"] = true;
  if (opts["compress"] === true) p["compress"] = true;
  for (let i = 1; i <= 5; i++) {
    const cv = str(opts[`classVar${i}`]);
    const ck = str(opts[`classKey${i}`]);
    if (cv !== undefined) p[`classifyingvariable${i}`] = cv;
    if (ck !== undefined) p[`classifyingkey${i}`] = ck;
  }
  return p as DataTableParams;
}

export function registerDataCommands(program: Command, deps: CliDeps): void {
  const data = program
    .command("data")
    .description("Retrieve statistical data (tables, cubes, time series, results)");

  for (const sub of JSON_SUBS) {
    const cmd = data
      .command(sub.name)
      .description(sub.desc)
      .argument("<name>", "object code (must be non-empty)", parseNonEmpty);
    addDataOptions(cmd).action(
      action(deps, async ({ client, global, opts }, [name]) => {
        renderJson(deps, global, await sub.run(client, name!, buildDataParams(opts, global)));
      }),
    );
  }

  for (const sub of FILE_SUBS) {
    const cmd = data
      .command(sub.name)
      .description(sub.desc)
      .argument("<name>", "object code (must be non-empty)", parseNonEmpty)
      .addOption(new Option("--format <fmt>", "download format").choices([...FORMATS]));
    addDataOptions(cmd).action(
      action(deps, async ({ client, global, opts }, [name]) => {
        const params: DataFileParams = buildDataParams(opts, global);
        if (typeof opts["format"] === "string") params.format = opts["format"] as DataFileFormat;
        renderRaw(deps, global, await sub.run(client, name!, params));
      }),
    );
  }
}
