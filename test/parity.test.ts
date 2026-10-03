// CLI <-> library parity: the same input through run() and through the library,
// on one recording mock transport, must give the same outcome — both reject and
// send nothing, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RegionalstatistikClient,
  type RegionalstatistikClientOptions,
} from "../src/client/client.js";
import { RegionalstatistikValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import * as params from "../src/client/params.js";
import { buildProgram } from "../src/cli/program.js";
import type { Command } from "commander";
import { jsonResponse, parity, requestKey, rawResponse, type ParityResult } from "./helpers.js";
import * as fx from "./fixtures.js";

const TOKEN_VALUE = "test-key";
const TOKEN = ["--token", TOKEN_VALUE];

function client(
  transport: Transport,
  options: Omit<RegionalstatistikClientOptions, "transport"> = {},
): RegionalstatistikClient {
  return new RegionalstatistikClient({ token: TOKEN_VALUE, ...options, transport });
}

/** Both sides reject the input and neither sends a request. */
function assertBothReject(p: ParityResult, libMessage?: RegExp): void {
  assert.equal(p.cli.code, 2, `CLI exit (stderr: ${p.cli.err})`);
  assert.equal(p.cli.requests.length, 0, "CLI sent a request");
  assert.equal(p.lib.ok, false, "library resolved");
  assert.equal(p.lib.requests.length, 0, "library sent a request");
  if (!p.lib.ok) {
    assert.ok(p.lib.error instanceof RegionalstatistikValidationError, `library threw ${String(p.lib.error)}`);
    if (libMessage) assert.match((p.lib.error as Error).message, libMessage);
  }
}

/** Both sides send the identical request. */
function assertSameRequest(p: ParityResult): void {
  assert.equal(p.cli.code, 0, `CLI exit (stderr: ${p.cli.err})`);
  assert.ok(p.lib.ok, `library rejected: ${p.lib.ok ? "" : String(p.lib.error)}`);
  assert.deepEqual(p.cli.requests.map(requestKey), p.lib.requests.map(requestKey));
  assert.equal(p.cli.requests.length, 1);
}

const ZIP = () => rawResponse(Buffer.from("PK\x03\x04zip"), "application/zip");

// ---- Finding 1 (PAT-9): blank ids, selections, search terms and filters ----------

const blankCases: Array<{
  label: string;
  argv: string[];
  lib: (c: RegionalstatistikClient) => Promise<unknown>;
  key: string;
  zip?: boolean;
}> = [
  {
    label: "data table --region-key '  '",
    argv: [...TOKEN, "data", "table", "12411-01-01-4", "--region-key", "  "],
    lib: (c) => c.data.table("12411-01-01-4", { regionalkey: "  " }),
    key: "regionalkey",
  },
  {
    label: "data cube C --class-key1 ' '",
    argv: [...TOKEN, "data", "cube", "C", "--class-key1", " "],
    lib: (c) => c.data.cube("C", { classifyingkey1: " " }),
    key: "classifyingkey1",
  },
  {
    label: "data table ''",
    argv: [...TOKEN, "data", "table", ""],
    lib: (c) => c.data.table(""),
    key: "name",
  },
  {
    label: "data timeseries ''",
    argv: [...TOKEN, "data", "timeseries", ""],
    lib: (c) => c.data.timeseries(""),
    key: "name",
  },
  {
    label: "data tablefile T --start-year ' '",
    argv: [...TOKEN, "-o", "out.zip", "data", "tablefile", "T", "--start-year", " "],
    lib: (c) => c.data.tableFile("T", { startyear: " " }),
    key: "startyear",
    zip: true,
  },
  {
    label: "data resultfile ''",
    argv: [...TOKEN, "-o", "out.zip", "data", "resultfile", ""],
    lib: (c) => c.data.resultFile(""),
    key: "name",
    zip: true,
  },
  {
    label: "find '  '",
    argv: [...TOKEN, "find", "  "],
    lib: (c) => c.find({ term: "  " }),
    key: "term",
  },
  {
    label: "find ''",
    argv: [...TOKEN, "find", ""],
    lib: (c) => c.find({ term: "" }),
    key: "term",
  },
  {
    label: "catalogue tables ' '",
    argv: [...TOKEN, "catalogue", "tables", " "],
    lib: (c) => c.catalogue.tables({ selection: " " }),
    key: "selection",
  },
  {
    label: "catalogue cubes 12411* --type ''",
    argv: [...TOKEN, "catalogue", "cubes", "12411*", "--type", ""],
    lib: (c) => c.catalogue.cubes({ selection: "12411*", type: "" }),
    key: "type",
  },
  {
    label: "catalogue tables 12411* --area ' '",
    argv: [...TOKEN, "catalogue", "tables", "12411*", "--area", " "],
    lib: (c) => c.catalogue.tables({ selection: "12411*", area: " " }),
    key: "area",
  },
  {
    label: "metadata table '  '",
    argv: [...TOKEN, "metadata", "table", "  "],
    lib: (c) => c.metadata.table("  "),
    key: "name",
  },
  {
    label: "metadata statistic X --area ''",
    argv: [...TOKEN, "metadata", "statistic", "X", "--area", ""],
    lib: (c) => c.metadata.statistic("X", { area: "" }),
    key: "area",
  },
];

for (const bc of blankCases) {
  test(`parity #1: ${bc.label} is rejected by both, with no request`, async () => {
    const p = await parity({
      argv: ["--compact", ...bc.argv],
      lib: (t) => bc.lib(client(t)),
      responder: bc.zip ? ZIP : () => jsonResponse(fx.dataTable),
    });
    assertBothReject(p, new RegExp(`^Invalid ${bc.key}: Expected a non-empty value\\.$`));
  });
}

test("parity #1: a library method rejects a blank value instead of throwing synchronously", () => {
  const c = new RegionalstatistikClient({ token: TOKEN_VALUE, transport: async () => jsonResponse({}) });
  const pending = c.metadata.table("");
  assert.ok(pending instanceof Promise);
  return assert.rejects(pending, RegionalstatistikValidationError);
});

test("parity #1: logincheck rejects a blank language before any request", async () => {
  let calls = 0;
  const c = new RegionalstatistikClient({
    token: TOKEN_VALUE,
    transport: async () => {
      calls += 1;
      return jsonResponse(fx.loginOk);
    },
  });
  await assert.rejects(c.logincheck(" " as never), /^RegionalstatistikValidationError: Invalid language: /);
  assert.equal(calls, 0);
});

test("parity #1 control: a non-blank filter sends the identical request on both sides", async () => {
  const p = await parity({
    argv: ["--compact", ...TOKEN, "--language", "de", "data", "table", "12411-01-01-4", "--region-key", "08221"],
    lib: (t) => client(t).data.table("12411-01-01-4", { language: "de", regionalkey: "08221" }),
    responder: () => jsonResponse(fx.dataTable),
  });
  assertSameRequest(p);
});

// ---- Finding 8 (PAT-12): the language allow-list (de, en) -------------------------

const languageCases: Array<{
  label: string;
  argv: string[];
  lib: (c: RegionalstatistikClient) => Promise<unknown>;
  zip?: boolean;
}> = [
  {
    label: "--language fr metadata cube X",
    argv: ["--language", "fr", "metadata", "cube", "X"],
    lib: (c) => c.metadata.cube("X", { language: "fr" as never }),
  },
  {
    label: "--language EN catalogue tables",
    argv: ["--language", "EN", "catalogue", "tables"],
    lib: (c) => c.catalogue.tables({ language: "EN" as never }),
  },
  {
    label: "--language '' data table T",
    argv: ["--language", "", "data", "table", "T"],
    lib: (c) => c.data.table("T", { language: "" as never }),
  },
  {
    label: "--language ' en' find bev",
    argv: ["--language", " en", "find", "bev"],
    lib: (c) => c.find({ term: "bev", language: " en" as never }),
  },
  {
    label: "--language xx logincheck",
    argv: ["--language", "xx", "logincheck"],
    lib: (c) => c.logincheck("xx" as never),
  },
  {
    label: "--language fr data cubefile X",
    argv: ["-o", "out.zip", "--language", "fr", "data", "cubefile", "X"],
    lib: (c) => c.data.cubeFile("X", { language: "fr" as never }),
    zip: true,
  },
];

for (const lc of languageCases) {
  test(`parity #8: ${lc.label} is rejected by both, with no request`, async () => {
    const p = await parity({
      argv: ["--compact", ...TOKEN, ...lc.argv],
      lib: (t) => lc.lib(client(t)),
      responder: lc.zip ? ZIP : () => jsonResponse(fx.tablesList),
    });
    assertBothReject(p, /^Invalid language: Allowed choices are de, en\.$/);
  });
}

test("parity #8 control: --language en sends the identical request on both sides", async () => {
  const p = await parity({
    argv: ["--compact", ...TOKEN, "--language", "en", "metadata", "cube", "X"],
    lib: (t) => client(t).metadata.cube("X", { language: "en" }),
    responder: () => jsonResponse(fx.metadataTable),
  });
  assertSameRequest(p);
});

test("parity #8: the CLI's --language choices are the library's LANGUAGES", () => {
  const choices = (cmd: Command, flag: string) => cmd.options.find((o) => o.long === flag)?.argChoices;
  assert.deepEqual(choices(buildProgram(), "--language"), [...params.LANGUAGES]);
});
