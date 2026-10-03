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

// ---- Finding 9 (PAT-12): find category, catalogue criteria, data file format -------

const enumCases: Array<{
  label: string;
  argv: string[];
  lib: (c: RegionalstatistikClient) => Promise<unknown>;
  msg: RegExp;
  zip?: boolean;
}> = [
  {
    label: "find bev --category Tables",
    argv: ["find", "bev", "--category", "Tables"],
    lib: (c) => c.find({ term: "bev", category: "Tables" as never }),
    msg: /^Invalid category: Allowed choices are all, tables, statistics, cubes, variables, time-series\.$/,
  },
  {
    label: "find bev --category ''",
    argv: ["find", "bev", "--category", ""],
    lib: (c) => c.find({ term: "bev", category: "" as never }),
    msg: /^Invalid category: Allowed choices are /,
  },
  {
    label: "catalogue tables x --search-criterion code",
    argv: ["catalogue", "tables", "x", "--search-criterion", "code"],
    lib: (c) => c.catalogue.tables({ selection: "x", searchcriterion: "code" as never }),
    msg: /^Invalid searchcriterion: Allowed choices are Code, Content\.$/,
  },
  {
    label: "catalogue cubes x --sort-criterion content",
    argv: ["catalogue", "cubes", "x", "--sort-criterion", "content"],
    lib: (c) => c.catalogue.cubes({ selection: "x", sortcriterion: "content" as never }),
    msg: /^Invalid sortcriterion: Allowed choices are Code, Content\.$/,
  },
  {
    label: "data cubefile X --format CSV",
    argv: ["-o", "out.zip", "data", "cubefile", "X", "--format", "CSV"],
    lib: (c) => c.data.cubeFile("X", { format: "CSV" as never }),
    msg: /^Invalid format: Allowed choices are datencsv, csv, ffcsv, xlsx, html, genml\.$/,
    zip: true,
  },
  {
    label: "data tablefile T --format ' csv'",
    argv: ["-o", "out.zip", "data", "tablefile", "T", "--format", " csv"],
    lib: (c) => c.data.tableFile("T", { format: " csv" as never }),
    msg: /^Invalid format: Allowed choices are /,
    zip: true,
  },
  {
    label: "data resultfile R --format zip",
    argv: ["-o", "out.zip", "data", "resultfile", "R", "--format", "zip"],
    lib: (c) => c.data.resultFile("R", { format: "zip" as never }),
    msg: /^Invalid format: Allowed choices are /,
    zip: true,
  },
];

for (const ec of enumCases) {
  test(`parity #9: ${ec.label} is rejected by both, with no request`, async () => {
    const p = await parity({
      argv: ["--compact", ...TOKEN, ...ec.argv],
      lib: (t) => ec.lib(client(t)),
      responder: ec.zip ? ZIP : () => jsonResponse(fx.findResult),
    });
    assertBothReject(p, ec.msg);
  });
}

test("parity #9 control: valid category, criterion and format send the identical request", async () => {
  const f = await parity({
    argv: ["--compact", ...TOKEN, "--language", "en", "find", "bev", "--category", "tables"],
    lib: (t) => client(t).find({ term: "bev", language: "en", category: "tables" }),
    responder: () => jsonResponse(fx.findResult),
  });
  assertSameRequest(f);
  const c = await parity({
    argv: ["--compact", ...TOKEN, "--language", "de", "catalogue", "tables", "x", "--search-criterion", "Code", "--sort-criterion", "Content"],
    lib: (t) => client(t).catalogue.tables({ language: "de", selection: "x", searchcriterion: "Code", sortcriterion: "Content" }),
    responder: () => jsonResponse(fx.tablesList),
  });
  assertSameRequest(c);
  const d = await parity({
    argv: ["--compact", ...TOKEN, "--language", "de", "-o", "out.zip", "data", "cubefile", "X", "--format", "csv"],
    lib: (t) => client(t).data.cubeFile("X", { language: "de", format: "csv" }),
    responder: ZIP,
  });
  assertSameRequest(d);
});

test("parity #9: the CLI's choices are the library's exported value lists", () => {
  const program = buildProgram();
  const sub = (cmd: Command, name: string) => cmd.commands.find((c) => c.name() === name)!;
  const choices = (cmd: Command, flag: string) => cmd.options.find((o) => o.long === flag)?.argChoices;
  assert.deepEqual(choices(sub(program, "find"), "--category"), [...params.FIND_CATEGORIES]);
  for (const name of ["tables", "cubes", "qualitysigns"]) {
    const cmd = sub(sub(program, "catalogue"), name);
    assert.deepEqual(choices(cmd, "--search-criterion"), [...params.CRITERIA]);
    assert.deepEqual(choices(cmd, "--sort-criterion"), [...params.CRITERIA]);
  }
  for (const name of ["tablefile", "cubefile", "timeseriesfile", "resultfile"]) {
    assert.deepEqual(choices(sub(sub(program, "data"), name), "--format"), [...params.DATA_FILE_FORMATS]);
  }
});

// ---- Finding 10 (PAT-15): no CLI-only request defaults ------------------------------

const defaultCases: Array<{ label: string; argv: string[]; lib: (c: RegionalstatistikClient) => Promise<unknown>; zip?: boolean }> = [
  { label: "find bev", argv: ["find", "bev"], lib: (c) => c.find({ term: "bev" }) },
  { label: "logincheck", argv: ["logincheck"], lib: (c) => c.logincheck() },
  { label: "catalogue tables 12411*", argv: ["catalogue", "tables", "12411*"], lib: (c) => c.catalogue.tables({ selection: "12411*" }) },
  { label: "catalogue modified", argv: ["catalogue", "modified"], lib: (c) => c.catalogue.modifiedData() },
  { label: "metadata table 12411-01-01-4", argv: ["metadata", "table", "12411-01-01-4"], lib: (c) => c.metadata.table("12411-01-01-4") },
  { label: "data table 12411-01-01-4", argv: ["data", "table", "12411-01-01-4"], lib: (c) => c.data.table("12411-01-01-4") },
  { label: "data cubefile X", argv: ["-o", "out.zip", "data", "cubefile", "X"], lib: (c) => c.data.cubeFile("X"), zip: true },
];

for (const dc of defaultCases) {
  test(`parity #10: ${dc.label} with no --language/--category sends the identical request`, async () => {
    const p = await parity({
      argv: ["--compact", ...TOKEN, ...dc.argv],
      lib: (t) => dc.lib(client(t)),
      responder: dc.zip ? ZIP : () => jsonResponse(fx.findResult),
    });
    assertSameRequest(p);
    const body = new URLSearchParams(p.cli.requests[0]!.body?.toString() ?? "");
    assert.equal(body.has("language"), false);
    assert.equal(body.has("category"), false);
  });
}

test("parity #10: --help names the server defaults for --language and --category", async () => {
  const p = await parity({ argv: ["--help"], lib: async () => undefined });
  assert.match(p.cli.out, /--language <lang>\s+response language \(server default: de\)/);
  const f = await parity({ argv: ["find", "--help"], lib: async () => undefined });
  assert.match(f.cli.out, /server default: all/);
});

// ---- Finding 6 (PAT-11): pagelength 1..MAX_PAGELENGTH --------------------------------

const NONNEG = /^Invalid pagelength: Expected a non-negative integer\.$/;
const pagelengthCases: Array<{ label: string; argv: string[]; lib: (c: RegionalstatistikClient) => Promise<unknown>; msg: RegExp }> = [
  { label: "catalogue tables --pagelength 0", argv: ["--pagelength", "0", "catalogue", "tables"], lib: (c) => c.catalogue.tables({ pagelength: 0 }), msg: /^Invalid pagelength: Must be >= 1\.$/ },
  { label: "catalogue tables --pagelength -1", argv: ["--pagelength", "-1", "catalogue", "tables"], lib: (c) => c.catalogue.tables({ pagelength: -1 }), msg: NONNEG },
  { label: "catalogue tables --pagelength 25001", argv: ["--pagelength", "25001", "catalogue", "tables"], lib: (c) => c.catalogue.tables({ pagelength: 25001 }), msg: /^Invalid pagelength: Must be <= 25000\.$/ },
  { label: "catalogue tables --pagelength 1.5", argv: ["--pagelength", "1.5", "catalogue", "tables"], lib: (c) => c.catalogue.tables({ pagelength: 1.5 }), msg: NONNEG },
  { label: "catalogue tables --pagelength NaN", argv: ["--pagelength", "NaN", "catalogue", "tables"], lib: (c) => c.catalogue.tables({ pagelength: NaN }), msg: NONNEG },
  { label: "catalogue tables --pagelength Infinity", argv: ["--pagelength", "Infinity", "catalogue", "tables"], lib: (c) => c.catalogue.tables({ pagelength: Infinity }), msg: NONNEG },
  { label: "catalogue tables --pagelength 1e20", argv: ["--pagelength", "99999999999999999999", "catalogue", "tables"], lib: (c) => c.catalogue.tables({ pagelength: 1e20 }), msg: NONNEG },
  { label: "find bev --pagelength 0", argv: ["--pagelength", "0", "find", "bev"], lib: (c) => c.find({ term: "bev", pagelength: 0 }), msg: /^Invalid pagelength: Must be >= 1\.$/ },
  { label: "catalogue results --pagelength -5", argv: ["--pagelength", "-5", "catalogue", "results"], lib: (c) => c.catalogue.results({ pagelength: -5 }), msg: NONNEG },
  { label: "catalogue qualitysigns --pagelength 30000", argv: ["--pagelength", "30000", "catalogue", "qualitysigns"], lib: (c) => c.catalogue.qualitySigns({ pagelength: 30000 }), msg: /^Invalid pagelength: Must be <= 25000\.$/ },
];

for (const pc of pagelengthCases) {
  test(`parity #6: ${pc.label} is rejected by both, with no request`, async () => {
    const p = await parity({
      argv: ["--compact", ...TOKEN, ...pc.argv],
      lib: (t) => pc.lib(client(t)),
      responder: () => jsonResponse(fx.tablesList),
    });
    assertBothReject(p, pc.msg);
  });
}

test("parity #6 control: --pagelength 25000 and 1 send the identical request", async () => {
  for (const n of [params.MAX_PAGELENGTH, 1]) {
    const p = await parity({
      argv: ["--compact", ...TOKEN, "--pagelength", String(n), "catalogue", "tables"],
      lib: (t) => client(t).catalogue.tables({ pagelength: n }),
      responder: () => jsonResponse(fx.tablesList),
    });
    assertSameRequest(p);
  }
});

// ---- Finding 7 (PAT-11): timeslices is a non-negative integer -----------------------

const TS = /^Invalid timeslices: Expected a non-negative integer\.$/;
const timesliceCases: Array<{ label: string; argv: string[]; lib: (c: RegionalstatistikClient) => Promise<unknown>; zip?: boolean }> = [
  { label: "data table T --timeslices=-1", argv: ["data", "table", "T", "--timeslices=-1"], lib: (c) => c.data.table("T", { timeslices: -1 }) },
  { label: "data table T --timeslices=1.5", argv: ["data", "table", "T", "--timeslices=1.5"], lib: (c) => c.data.table("T", { timeslices: 1.5 }) },
  { label: "data table T --timeslices=NaN", argv: ["data", "table", "T", "--timeslices=NaN"], lib: (c) => c.data.table("T", { timeslices: NaN }) },
  { label: "data result T --timeslices=Infinity", argv: ["data", "result", "T", "--timeslices=Infinity"], lib: (c) => c.data.result("T", { timeslices: Infinity }) },
  {
    label: "data resultfile T --timeslices=1e20",
    argv: ["-o", "out.zip", "data", "resultfile", "T", "--timeslices=99999999999999999999"],
    lib: (c) => c.data.resultFile("T", { timeslices: 1e20 }),
    zip: true,
  },
  {
    label: "data cubefile T --timeslices=-1",
    argv: ["-o", "out.zip", "data", "cubefile", "T", "--timeslices=-1"],
    lib: (c) => c.data.cubeFile("T", { timeslices: -1 }),
    zip: true,
  },
];

for (const tc of timesliceCases) {
  test(`parity #7: ${tc.label} is rejected by both, with no request`, async () => {
    const p = await parity({
      argv: ["--compact", ...TOKEN, ...tc.argv],
      lib: (t) => tc.lib(client(t)),
      responder: tc.zip ? ZIP : () => jsonResponse(fx.dataTable),
    });
    assertBothReject(p, TS);
  });
}

test("parity #7 control: --timeslices 0 and 3 send the identical request", async () => {
  for (const n of [0, 3]) {
    const p = await parity({
      argv: ["--compact", ...TOKEN, "data", "table", "T", "--timeslices", String(n)],
      lib: (t) => client(t).data.table("T", { timeslices: n }),
      responder: () => jsonResponse(fx.dataTable),
    });
    assertSameRequest(p);
  }
});

// ---- Finding 4 (PAT-8): engine limits timeoutMs, maxRetries, maxResponseBytes -------

const limitCases: Array<{ label: string; argv: string[]; opts: Partial<RegionalstatistikClientOptions>; msg: RegExp }> = [
  { label: "--timeout -1", argv: ["--timeout", "-1"], opts: { timeoutMs: -1 }, msg: /^Invalid timeoutMs: Expected a non-negative integer\.$/ },
  { label: "--timeout NaN", argv: ["--timeout", "NaN"], opts: { timeoutMs: NaN }, msg: /^Invalid timeoutMs: Expected a non-negative integer\.$/ },
  { label: "--timeout 1.5", argv: ["--timeout", "1.5"], opts: { timeoutMs: 1.5 }, msg: /^Invalid timeoutMs: Expected a non-negative integer\.$/ },
  { label: "--timeout 2147483648", argv: ["--timeout", "2147483648"], opts: { timeoutMs: 2147483648 }, msg: /^Invalid timeoutMs: Must be <= 2147483647\.$/ },
  { label: "--max-response-bytes -1", argv: ["--max-response-bytes", "-1"], opts: { maxResponseBytes: -1 }, msg: /^Invalid maxResponseBytes: Expected a non-negative integer\.$/ },
  { label: "--max-response-bytes NaN", argv: ["--max-response-bytes", "NaN"], opts: { maxResponseBytes: NaN }, msg: /^Invalid maxResponseBytes: Expected a non-negative integer\.$/ },
  { label: "--max-retries 11", argv: ["--max-retries", "11"], opts: { maxRetries: 11 }, msg: /^Invalid maxRetries: Must be <= 10\.$/ },
  { label: "--max-retries 1.5", argv: ["--max-retries", "1.5"], opts: { maxRetries: 1.5 }, msg: /^Invalid maxRetries: Expected a non-negative integer\.$/ },
  { label: "--max-retries Infinity", argv: ["--max-retries", "Infinity"], opts: { maxRetries: Infinity }, msg: /^Invalid maxRetries: Expected a non-negative integer\.$/ },
  { label: "--max-retries -1", argv: ["--max-retries", "-1"], opts: { maxRetries: -1 }, msg: /^Invalid maxRetries: Expected a non-negative integer\.$/ },
];

for (const lc of limitCases) {
  test(`parity #4: ${lc.label} is rejected by both, with no request`, async () => {
    const p = await parity({
      argv: ["--compact", ...TOKEN, ...lc.argv, "catalogue", "tables", "x"],
      lib: async (t) => client(t, lc.opts).catalogue.tables({ selection: "x" }),
      responder: () => jsonResponse(fx.tablesList),
    });
    assertBothReject(p, lc.msg);
  });
}

test("parity #4 control: the boundary values are accepted and sent by both", async () => {
  const p = await parity({
    argv: ["--compact", ...TOKEN, "--timeout", "0", "--max-retries", "10", "--max-response-bytes", "0", "catalogue", "tables", "x"],
    lib: (t) => client(t, { timeoutMs: 0, maxRetries: 10, maxResponseBytes: 0 }).catalogue.tables({ selection: "x" }),
    responder: () => jsonResponse(fx.tablesList),
  });
  assertSameRequest(p);
  assert.equal(p.cli.requests[0]!.timeoutMs, 0);
  assert.equal(p.lib.requests[0]!.timeoutMs, 0);
});

test("parity #4: the CLI's --max-retries bound is the library's MAX_RETRIES", async () => {
  const { MAX_RETRIES } = await import("../src/client/engine.js");
  assert.equal(MAX_RETRIES, 10);
  const opt = buildProgram().options.find((o) => o.long === "--max-retries")!;
  assert.match(opt.description, new RegExp(`\\(0\\.\\.${MAX_RETRIES};`));
});

// ---- Finding 3 (PAT-5/PAT-6): header values for credentials and the User-Agent -------

const headerCases: Array<{
  label: string;
  argv: string[];
  env?: Record<string, string>;
  lib: (t: Transport) => Promise<unknown>;
  msg: RegExp;
}> = [
  {
    label: "--user-agent with CR/LF",
    argv: [...TOKEN, "--user-agent", "a\r\nX-Evil: 1", "catalogue", "tables", "x"],
    lib: async (t) => client(t, { userAgent: "a\r\nX-Evil: 1" }).catalogue.tables({ selection: "x" }),
    msg: /^Invalid userAgent: Value contains control characters\.$/,
  },
  {
    label: "--user-agent ''",
    argv: [...TOKEN, "--user-agent", "", "catalogue", "tables", "x"],
    lib: async (t) => client(t, { userAgent: "" }).catalogue.tables({ selection: "x" }),
    msg: /^Invalid userAgent: Expected a non-empty value\.$/,
  },
  {
    label: "--user-agent 'Agent ✓'",
    argv: [...TOKEN, "--user-agent", "Agent ✓", "catalogue", "tables", "x"],
    lib: async (t) => client(t, { userAgent: "Agent ✓" }).catalogue.tables({ selection: "x" }),
    msg: /^Invalid userAgent: Value contains characters outside Latin-1 \(above U\+00FF\)\.$/,
  },
  {
    label: "--user-agent with DEL",
    argv: [...TOKEN, "--user-agent", "a\x7fb", "hello"],
    lib: async (t) => new RegionalstatistikClient({ transport: t, userAgent: "a\x7fb" }).whoami(),
    msg: /^Invalid userAgent: Value contains control characters\.$/,
  },
  {
    label: "--token with CR/LF",
    argv: ["--token", "tok\r\nX: y", "catalogue", "tables", "x"],
    lib: async (t) => new RegionalstatistikClient({ transport: t, token: "tok\r\nX: y" }).catalogue.tables({ selection: "x" }),
    msg: /^Invalid token: Value contains control characters\.$/,
  },
  {
    label: "--token ' t '",
    argv: ["--token", " t ", "catalogue", "tables", "x"],
    lib: async (t) => new RegionalstatistikClient({ transport: t, token: " t " }).catalogue.tables({ selection: "x" }),
    msg: /^Invalid token: Value has leading or trailing whitespace, which an HTTP header cannot carry\.$/,
  },
  {
    label: "env REGIONALSTATISTIK_PASSWORD=' pass '",
    argv: ["catalogue", "tables", "x"],
    env: { REGIONALSTATISTIK_USERNAME: "user", REGIONALSTATISTIK_PASSWORD: " pass " },
    lib: async (t) =>
      new RegionalstatistikClient({ transport: t, username: "user", password: " pass " }).catalogue.tables({ selection: "x" }),
    msg: /^Invalid password: Value has leading or trailing whitespace/,
  },
  {
    label: "env REGIONALSTATISTIK_API_TOKEN=' test-key '",
    argv: ["catalogue", "tables", "x"],
    env: { REGIONALSTATISTIK_API_TOKEN: " test-key " },
    lib: async (t) => new RegionalstatistikClient({ transport: t, token: " test-key " }).catalogue.tables({ selection: "x" }),
    msg: /^Invalid token: Value has leading or trailing whitespace/,
  },
  {
    label: "env REGIONALSTATISTIK_USERNAME='usér✓'",
    argv: ["catalogue", "tables", "x"],
    env: { REGIONALSTATISTIK_USERNAME: "usér✓", REGIONALSTATISTIK_PASSWORD: "pass" },
    lib: async (t) =>
      new RegionalstatistikClient({ transport: t, username: "usér✓", password: "pass" }).catalogue.tables({ selection: "x" }),
    msg: /^Invalid username: Value contains characters outside Latin-1 \(above U\+00FF\)\.$/,
  },
];

for (const hc of headerCases) {
  test(`parity #3: ${hc.label} is rejected by both, with no request`, async () => {
    const p = await parity({
      argv: ["--compact", ...hc.argv],
      ...(hc.env ? { env: hc.env } : {}),
      lib: hc.lib,
      responder: () => jsonResponse(fx.tablesList),
    });
    assertBothReject(p, hc.msg);
  });
}

for (const ua of ["é", "a\tb", " ua "]) {
  test(`parity #3 control: --user-agent ${JSON.stringify(ua)} is sent by both`, async () => {
    const p = await parity({
      argv: ["--compact", "--user-agent", ua, "hello"],
      lib: (t) => new RegionalstatistikClient({ transport: t, userAgent: ua }).whoami(),
      responder: () => jsonResponse(fx.whoami),
    });
    assert.equal(p.cli.code, 0, p.cli.err);
    assert.ok(p.lib.ok);
    assert.equal(p.cli.requests[0]!.headers?.["User-Agent"], ua);
    assert.equal(p.lib.requests[0]!.headers?.["User-Agent"], ua);
  });
}

test("parity #3 control: a TAB inside a password is accepted and sent by both", async () => {
  const p = await parity({
    argv: ["--compact", "catalogue", "tables", "x"],
    env: { REGIONALSTATISTIK_USERNAME: "user", REGIONALSTATISTIK_PASSWORD: "pa\tss" },
    lib: (t) => new RegionalstatistikClient({ transport: t, username: "user", password: "pa\tss" }).catalogue.tables({ selection: "x" }),
    responder: () => jsonResponse(fx.tablesList),
  });
  assertSameRequest(p);
});

// ---- Finding 5 (PAT-1): base URL userinfo and whitespace -----------------------------

const baseUrlCases: Array<{ url: string; msg: RegExp }> = [
  { url: "https://u:p@example.org", msg: /^Invalid baseUrl: Must not embed credentials \(user:pass@host\)\.$/ },
  { url: "https://tok@example.org", msg: /^Invalid baseUrl: Must not embed credentials/ },
  { url: "https://example.org ", msg: /^Invalid baseUrl: A base URL cannot have surrounding whitespace\.$/ },
  { url: " https://example.org", msg: /^Invalid baseUrl: A base URL cannot have surrounding whitespace\.$/ },
  { url: "https://h.example\t", msg: /^Invalid baseUrl: A base URL cannot have surrounding whitespace\.$/ },
  { url: "https://h.example/ ", msg: /^Invalid baseUrl: A base URL cannot have surrounding whitespace\.$/ },
  { url: "https://h.example/p\tx", msg: /^Invalid baseUrl: A base URL cannot contain whitespace or control characters\.$/ },
];

for (const bc of baseUrlCases) {
  test(`parity #5: base URL ${JSON.stringify(bc.url)} is rejected by both, with no request`, async () => {
    const p = await parity({
      argv: ["--compact", ...TOKEN, "--base-url", bc.url, "catalogue", "tables", "x"],
      lib: async (t) => client(t, { baseUrl: bc.url }).catalogue.tables({ selection: "x" }),
      responder: () => jsonResponse(fx.tablesList),
    });
    assertBothReject(p, bc.msg);
    if (!p.lib.ok) assert.doesNotMatch((p.lib.error as Error).message, /u:p|tok@|example\.org/);
  });
}

test("parity #5: the CLI keeps its flag hint for an embedded credential", async () => {
  const p = await parity({
    argv: ["--compact", "--base-url", "https://u:p@example.org", "hello"],
    lib: async () => undefined,
  });
  assert.equal(p.cli.code, 2);
  assert.match(p.cli.err, /Must not embed credentials \(user:pass@host\)\. Use --token or --username\/--password\./);
});

test("parity #5 control: a base URL with a path prefix sends the identical request", async () => {
  const p = await parity({
    argv: ["--compact", ...TOKEN, "--base-url", "https://h.example/prefix/", "catalogue", "tables", "x"],
    lib: (t) => client(t, { baseUrl: "https://h.example/prefix/" }).catalogue.tables({ selection: "x" }),
    responder: () => jsonResponse(fx.tablesList),
  });
  assertSameRequest(p);
  assert.equal(p.lib.requests[0]!.url, "https://h.example/prefix/genesisws/rest/2020/catalogue/tables");
});
