// P10 (fix plan 2026-10-06): GENESIS ignores a parameter it does not know and answers
// with the whole unfiltered result, so the library rejects unknown keys, `__proto__`,
// lists and wrong value types before any request, and the CLI rejects a repeated
// single-value flag instead of silently keeping the last one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RegionalstatistikClient } from "../src/client/client.js";
import { RegionalstatistikValidationError } from "../src/client/errors.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ok = { Ident: {}, Status: { Code: 0, Content: "erfolgreich", Type: "Information" }, Parameter: {}, Copyright: "", List: [], Tables: [], Object: {} };

function recording() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(ok)) };
  };
  return { requests, client: new RegionalstatistikClient({ token: TOKEN, transport }) };
}

type Any = never;

test("P10: unknown, misspelt and prototype keys are rejected before any request", async () => {
  const { requests, client } = recording();
  const bad: Array<[string, () => Promise<unknown>]> = [
    ["catalogue selction", () => client.catalogue.tables({ selction: "124*" } as Any)],
    ["data startYear", () => client.data.table("12411-0001", { startYear: "2020" } as Any)],
    ["data format (JSON endpoint)", () => client.data.table("12411-0001", { format: "csv" } as Any)],
    ["metadata startyear", () => client.metadata.table("12411-0001", { startyear: "2020" } as Any)],
    ["find categroy", () => client.find({ term: "x", categroy: "tables" } as Any)],
    ["__proto__", () => client.catalogue.tables(JSON.parse('{"__proto__": {"x": 1}}') as Any)],
    ["constructor", () => client.catalogue.tables({ constructor: "x" } as Any)],
  ];
  for (const [label, call] of bad) {
    await assert.rejects(call(), RegionalstatistikValidationError, label);
  }
  assert.equal(requests.length, 0);
});

test("P10: lists, NaN, objects and wrong scalar types are rejected", async () => {
  const { requests, client } = recording();
  const bad: Array<[string, () => Promise<unknown>]> = [
    ["array selection", () => client.catalogue.tables({ selection: ["124*", "125*"] } as Any)],
    ["array regionalkey", () => client.data.table("x", { regionalkey: ["01", "02"] } as Any)],
    ["NaN pagelength", () => client.find({ term: "x", pagelength: Number.NaN })],
    ["object startyear", () => client.data.table("x", { startyear: { y: 2020 } } as Any)],
    ["number startyear", () => client.data.table("x", { startyear: 2020 } as Any)],
    ["string transpose", () => client.data.table("x", { transpose: "true" } as Any)],
  ];
  for (const [label, call] of bad) {
    await assert.rejects(call(), RegionalstatistikValidationError, label);
  }
  assert.equal(requests.length, 0);
});

test("P10: allowUnknownParams sends an unknown scalar, but never a list or __proto__", async () => {
  const { requests, client } = recording();
  await client.catalogue.tables({ selection: "1*", newparam: "x" } as Any, { allowUnknownParams: true });
  assert.match(String(requests[0]!.body), /newparam=x/);
  await assert.rejects(client.catalogue.tables({ newparam: ["a", "b"] } as Any, { allowUnknownParams: true }), RegionalstatistikValidationError);
  await assert.rejects(client.catalogue.tables(JSON.parse('{"__proto__": "x"}') as Any, { allowUnknownParams: true }), RegionalstatistikValidationError);
  await assert.rejects(client.catalogue.tables({}, "yes" as Any), RegionalstatistikValidationError);
  assert.equal(requests.length, 1);
});

test("P10: a repeated single-value flag is a usage error, not 'last one wins'", async () => {
  for (const argv of [
    ["data", "table", "12411-0001", "--start-year", "2020", "--start-year", "2021"],
    ["--pagelength", "5", "find", "x", "--pagelength", "10"],
    ["--token", TOKEN, "--token", "fedcba9876543210fedcba9876543210", "catalogue", "tables"],
    ["catalogue", "tables", "--area", "all", "--area", "free"],
    ["find", "x", "--category", "tables", "--category", "cubes"],
  ]) {
    const err: string[] = [];
    let requests = 0;
    const deps: CliDeps = {
      io: { out: () => {}, err: (s) => err.push(s), writeFile: () => {}, fileExists: () => false, outBinary: () => {} },
      env: { REGIONALSTATISTIK_API_TOKEN: TOKEN },
      createClient: (opts) =>
        new RegionalstatistikClient({ ...opts, transport: async () => (requests++, { status: 200, headers: {}, body: Buffer.from(JSON.stringify(ok)) }) }),
    };
    assert.equal(await run(argv, deps), 2, `${argv.join(" ")}: ${err.join("\n")}`);
    assert.equal(requests, 0);
    assert.match(err.join("\n"), /more than once/);
  }
});
