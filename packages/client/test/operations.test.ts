// The skills' use cases as library functions (src/operations.ts), with the traps the skills
// document as test cases. Every answer comes from test/recorded.ts; nothing reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RegionalstatistikClient } from "../src/client.js";
import { RegionalstatistikApiError, RegionalstatistikParseError, RegionalstatistikValidationError } from "../src/errors.js";
import type { HttpRequest, HttpResponse } from "../src/http.js";
import { browseCatalogue, describeObject, fetchData, findStatistics, germanNumber, getFlatTable, splitCsvLine } from "../src/operations.js";
import { readZip } from "../src/zip.js";
import { bodyOf, jsonResponse, makeMockTransport, rawResponse } from "./helpers.js";
import {
  BAD_LOGIN,
  DATA_12411_01_01_4,
  DATA_SYMBOLS,
  EMPTY_104,
  FFCSV_12411_01_01_4,
  FIND_ALL,
  FIND_NONE,
  FIND_TABLES,
  genesis,
  METADATA_12411_01_01_4,
  NOT_AUTHORIZED,
  TABLES_12411,
  zipOf,
} from "./recorded.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

/** A client whose requests `answer` answers by endpoint (the path after /2020/). */
function clientFor(answer: (endpoint: string, request: HttpRequest) => HttpResponse) {
  const upstream = makeMockTransport((request) => answer(new URL(request.url).pathname.replace(/^.*\/rest\/2020\//, ""), request));
  return { client: new RegionalstatistikClient({ token: TOKEN, transport: upstream.transport, maxRetries: 0 }), upstream };
}

const endpoints = (calls: readonly HttpRequest[]) => calls.map((request) => new URL(request.url).pathname.replace(/^.*\/rest\/2020\//, ""));

test("germanNumber: thousands dots and a decimal comma; region keys, dates and plain-dot decimals stay text", () => {
  assert.equal(germanNumber("3.878.100"), 3878100);
  assert.equal(germanNumber("162.273"), 162273);
  assert.equal(germanNumber("1.234,5"), 1234.5);
  assert.equal(germanNumber("-0,8"), -0.8);
  assert.equal(germanNumber("2023"), 2023);
  assert.equal(germanNumber("0"), 0);
  // 08221 (Heidelberg), 11000 (Berlin), 14612000 (Dresden): keys, never numbers.
  for (const text of ["01", "08221", "11000", "14612000", "31.12.2023", "1.5", "12411-01-01-4", "...", "-", ".", "x", "", "1.23", "1,2,3"]) {
    assert.equal(germanNumber(text), undefined, text);
  }
});

test("germanNumber: a figure with more digits than a number holds exactly stays text, never other digits", () => {
  assert.equal(germanNumber("9.007.199.254.740.991"), 9007199254740991, "the largest exact whole number");
  assert.equal(germanNumber("9.007.199.254.740.993"), undefined);
  assert.equal(germanNumber("123.456.789.012.345.678"), undefined);
  assert.equal(germanNumber("123.456.789.012,345"), 123456789012.345, "15 digits are exact");
  assert.equal(germanNumber("1.234.567.890.123,4567"), undefined, "17 digits with a fraction are not");
  assert.equal(germanNumber("0,000000000000000012345"), 1.2345e-17, "leading zeros of a fraction aren't digits of the figure");
});

test("splitCsvLine: semicolons, quoted cells with the delimiter and doubled quotes", () => {
  assert.deepEqual(splitCsvLine(";Insgesamt;"), ["", "Insgesamt", ""]);
  assert.deepEqual(splitCsvLine('a;"b;c";"say ""hi"""'), ["a", "b;c", 'say "hi"']);
  assert.deepEqual(splitCsvLine("a,b", ","), ["a", "b"]);
});

test("fetchData: the CSV inside Object.Content is decoded line by line; a region key alone narrows the request", async () => {
  const { client, upstream } = clientFor(() => jsonResponse(DATA_12411_01_01_4));
  const result = await fetchData(client, { code: "12411-01-01-4", regionKey: "08221,08222,11000", startYear: "2023" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.searched, { startYear: "2023", regionKey: "08221,08222,11000" });
  assert.deepEqual(result.lines[5], ["31.12.2023", "08221", "Heidelberg, Stadtkreis", 162273, 78935, 83338]);
  assert.equal(result.total, 10);
  assert.match(result.copyright, /Statistische Ämter des Bundes und der Länder/);
  const body = bodyOf(upstream.last());
  assert.equal(body.get("name"), "12411-01-01-4");
  assert.equal(body.get("regionalkey"), "08221,08222,11000");
  assert.equal(body.get("regionalvariable"), null, "no regional variable is needed when the table's depth matches");
  assert.equal(body.get("startyear"), "2023");
  assert.deepEqual(endpoints(upstream.calls), ["data/table"]);
});

test("fetchData: a region key column stays text: Berlin's 11000 is a key like Heidelberg's 08221, not a number", async () => {
  const { client } = clientFor(() => jsonResponse(DATA_12411_01_01_4));
  const result = await fetchData(client, { code: "12411-01-01-4" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.lines[7], ["31.12.2023", "11000", "Berlin, Stadt", 3878100, 1906524, 1971576]);
});

test("fetchData: a Land key column stays text whole: Berlin's 11 is a key where Baden-Württemberg's 08 is one", async () => {
  const laender = { ...DATA_SYMBOLS, Object: { Code: "12411-01-01-2", Content: "Land;Schlüssel;2023\nBaden-Württemberg;08;11.280.257\nBerlin;11;3.878.100\n" } };
  const { client } = clientFor(() => jsonResponse(laender));
  const result = await fetchData(client, { code: "12411-01-01-2" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.lines.slice(1), [["Baden-Württemberg", "08", 11280257], ["Berlin", "11", 3878100]]);
});

test("fetchData: Land keys 10 to 16 stay text when no key in the column has a leading zero: the keys asked for mark the column", async () => {
  const content = "Land;Schlüssel;Hochschulen;Einwohner\nSaarland;10;10;992.666\nBerlin;11;12;3.878.100\nThüringen;16;14;2.114.870\n";
  const laender = { ...DATA_SYMBOLS, Object: { Code: "12411-01-01-2", Content: content } };
  for (const regionKey of ["1*", "10,11,16", " 10 , 11 , 16 "]) {
    const { client } = clientFor(() => jsonResponse(laender));
    const result = await fetchData(client, { code: "12411-01-01-2", regionKey });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.lines.slice(1), [["Saarland", "10", 10, 992666], ["Berlin", "11", 12, 3878100], ["Thüringen", "16", 14, 2114870]], regionKey);
  }
  // Three-digit Regierungsbezirk keys the same; a pattern full of stars stays quick.
  const bezirke = { ...DATA_SYMBOLS, Object: { Code: "12411-01-01-3", Content: "31.12.2023;111;Bezirk;1.000\n31.12.2023;112;Bezirk;2.000\n" } };
  const { client } = clientFor(() => jsonResponse(bezirke));
  const result = await fetchData(client, { code: "12411-01-01-3", regionKey: `11*,${"1*".repeat(200)}` });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.lines.map((line) => line[1]), ["111", "112"]);
});

test("fetchData: value symbols stay text and are named, never 0; a Gemeinde key stays text", async () => {
  const { client } = clientFor(() => jsonResponse(DATA_SYMBOLS));
  const result = await fetchData(client, { code: "82111-01-03-5" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.lines[1], ["Heidelberg", "08221000", 1234.5, "..."]);
  assert.deepEqual(result.lines[2], ["Bammental", "08226006", "-", "."]);
  assert.deepEqual(Object.keys(result.symbols).sort(), ["-", ".", "...", "/", "x"]);
  assert.match(result.symbols["."] ?? "", /unknown or kept secret/);
});

test("fetchData: lines are paged by offset and limit; total counts them all", async () => {
  const { client } = clientFor(() => jsonResponse(DATA_12411_01_01_4));
  const result = await fetchData(client, { code: "12411-01-01-4", offset: 5, limit: 2 });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.offset, 5);
  assert.equal(result.total, 10);
  assert.deepEqual(result.lines.map((line) => line[1]), ["08221", "08222"]);
});

test("fetchData: Status 104 for a code that doesn't exist is empty, 'no such code', checked against the catalogue", async () => {
  const { client, upstream } = clientFor((endpoint) =>
    endpoint === "catalogue/tables" ? jsonResponse({ ...EMPTY_104("catalogue", "tables"), List: [] }) : jsonResponse(EMPTY_104("data", "table")),
  );
  const result = await fetchData(client, { code: "99999-99-99-4", regionKey: "08221" });
  assert.equal(result.status, "empty");
  if (result.status !== "empty") return;
  assert.match(result.reason, /no table with the code 99999-99-99-4/);
  assert.deepEqual(endpoints(upstream.calls), ["data/table", "catalogue/tables"]);
  assert.equal(bodyOf(upstream.last()).get("selection"), "99999-99-99-4");
});

test("fetchData: Status 104 for a code the catalogue lists means the selection excluded everything, with the region key's format", async () => {
  const { client } = clientFor((endpoint) => (endpoint === "catalogue/tables" ? jsonResponse(TABLES_12411) : jsonResponse(EMPTY_104("data", "table"))));
  const result = await fetchData(client, { code: "12411-01-01-4", regionKey: "8221" });
  assert.equal(result.status, "empty");
  if (result.status !== "empty") return;
  assert.match(result.reason, /exists, but the selection excluded every value/);
  assert.match(result.reason, /a Kreis has 5 digits like 08221, a Gemeinde 8/);
  assert.deepEqual(result.searched, { regionKey: "8221" });
});

test("fetchData: a catalogue that lists only other codes (12411-01-01-4 for 12411-01-01) means no such code", async () => {
  const { client } = clientFor((endpoint) => (endpoint === "catalogue/tables" ? jsonResponse(TABLES_12411) : jsonResponse(EMPTY_104("data", "table"))));
  const result = await fetchData(client, { code: "12411-01-01" });
  assert.equal(result.status === "empty" && /no table with the code 12411-01-01 /.test(result.reason), true);
});

test("fetchData: a saved result is in no catalogue: an empty one says both reasons, with no second request", async () => {
  const { client, upstream } = clientFor(() => jsonResponse(EMPTY_104("data", "result")));
  const result = await fetchData(client, { kind: "result", code: "MYRESULT" });
  assert.equal(result.status, "empty");
  assert.deepEqual(endpoints(upstream.calls), ["data/result"]);
});

test("fetchData: too large (Status 98) is the client's error, with the code", async () => {
  const tooLarge = clientFor(() =>
    jsonResponse({ ...DATA_12411_01_01_4, Status: { Code: 98, Content: "Die Tabelle ist zu groß für einen direkten Abruf.", Type: "Information" } }),
  );
  await assert.rejects(fetchData(tooLarge.client, { code: "12411-01-01-5" }), (err: unknown) => err instanceof RegionalstatistikApiError && err.code === 98);
});

test("fetchData: classifying variables and keys, the region level and contents go out as GENESIS's parameters", async () => {
  const { client, upstream } = clientFor(() => jsonResponse(DATA_12411_01_01_4));
  await fetchData(client, {
    code: "12411-01-01-4",
    regionVariable: "KREISE",
    regionKey: "08*",
    classes: [{ variable: "GES", key: "GESW" }, { variable: "ALTX17" }],
    contents: "BEVSTD",
    timeslices: 3,
    language: "en",
  });
  const body = bodyOf(upstream.last());
  assert.equal(body.get("regionalvariable"), "KREISE");
  assert.equal(body.get("regionalkey"), "08*");
  assert.equal(body.get("classifyingvariable1"), "GES");
  assert.equal(body.get("classifyingkey1"), "GESW");
  assert.equal(body.get("classifyingvariable2"), "ALTX17");
  assert.equal(body.get("classifyingkey2"), null);
  assert.equal(body.get("contents"), "BEVSTD");
  assert.equal(body.get("timeslices"), "3");
  assert.equal(body.get("language"), "en");
});

test("fetchData: a wildcard code, a sixth class and a limit over 1000 are refused before any request", async () => {
  const { client, upstream } = clientFor(() => jsonResponse(DATA_12411_01_01_4));
  await assert.rejects(fetchData(client, { code: "12411*" }), (err: unknown) => err instanceof RegionalstatistikValidationError && /exact/.test(err.message));
  const six = Array.from({ length: 6 }, (_, i) => ({ variable: `V${i}` }));
  await assert.rejects(fetchData(client, { code: "12411-01-01-4", classes: six }), /at most five/);
  await assert.rejects(fetchData(client, { code: "12411-01-01-4", limit: 1001 }), RegionalstatistikValidationError);
  await assert.rejects(fetchData(client, { code: "12411-01-01-4", regionKey: " " }), RegionalstatistikValidationError);
  assert.equal(upstream.calls.length, 0);
});

test("findStatistics: tables by default; titles on one line with their regional depth; Valid and the empty Time left out", async () => {
  const { client, upstream } = clientFor(() => jsonResponse(FIND_TABLES));
  const result = await findStatistics(client, { term: "Bevölkerung", limit: 3 });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.matches.length, 3);
  assert.deepEqual(result.matches[0], {
    type: "table",
    code: "12411-01-01-4",
    title: "Bevölkerungsstand: Bevölkerung nach Geschlecht - Stichtag 31.12. - regionale Tiefe: Kreise und krfr. Städte",
    regionalDepth: "Kreise und krfr. Städte",
  });
  assert.equal(result.matches[1]?.regionalDepth, "Gemeinden");
  assert.equal(result.matches[2]?.regionalDepth, "Kreise und krfr. Städte");
  const body = bodyOf(upstream.last());
  assert.equal(body.get("category"), "tables");
  assert.equal(body.get("pagelength"), "3");
});

test("findStatistics: a type's list as long as the limit is not complete, as in browseCatalogue; under it, complete", async () => {
  const at = await findStatistics(clientFor(() => jsonResponse(FIND_TABLES)).client, { term: "Bevölkerung", limit: 3 });
  assert.equal(at.status, "ok");
  if (at.status !== "ok") return;
  assert.equal(at.complete, false);
  const under = await findStatistics(clientFor(() => jsonResponse(FIND_TABLES)).client, { term: "Bevölkerung", limit: 20 });
  assert.equal(under.status, "ok");
  if (under.status !== "ok") return;
  assert.equal(under.complete, true);
});

test("findStatistics: category all collects every list; counts that come as strings are numbers", async () => {
  const { client } = clientFor(() => jsonResponse(FIND_ALL));
  const result = await findStatistics(client, { term: "Bevölkerungsstand", category: "all", limit: 2 });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(
    result.matches.map((m) => `${m.type} ${m.code}`),
    ["table 12411-01-01-4", "table 12411-01-01-5", "statistic 12411", "variable BEVSTD", "variable KREISE"],
  );
  assert.equal(result.matches.find((m) => m.code === "12411")?.cubes, 6);
  assert.equal(result.matches.find((m) => m.code === "KREISE")?.values, 400);
  assert.equal(result.matches.find((m) => m.code === "BEVSTD")?.variableType, "Wert");
});

test("findStatistics: no hit is success with every list null: empty, with what was searched", async () => {
  const { client } = clientFor(() => jsonResponse(FIND_NONE));
  const result = await findStatistics(client, { term: "Xyzzyquux" });
  assert.equal(result.status, "empty");
  if (result.status !== "empty") return;
  assert.deepEqual(result.searched, { term: "Xyzzyquux", category: "tables" });
  assert.match(result.reason, /category all/);
});

test("findStatistics: a decomposed umlaut is sent composed (NFC) and trimmed", async () => {
  const { client, upstream } = clientFor(() => jsonResponse(FIND_TABLES));
  await findStatistics(client, { term: "Bevölkerung " });
  assert.equal(bodyOf(upstream.last()).get("term"), "Bevölkerung");
});

test("browseCatalogue: a code pattern lists the tables of a statistic at every depth; complete when under the limit", async () => {
  const { client, upstream } = clientFor(() => jsonResponse(TABLES_12411));
  const result = await browseCatalogue(client, { selection: "12411*" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map((item) => item.regionalDepth), ["Kreise und krfr. Städte", "Gemeinden", "Kreise und krfr. Städte"]);
  assert.equal(result.items[0]?.time, "1995-2023");
  assert.equal(result.complete, true);
  const body = bodyOf(upstream.last());
  assert.equal(body.get("selection"), "12411*");
  assert.equal(body.get("searchcriterion"), "Code");
  assert.equal(body.get("sortcriterion"), "Code");
  assert.deepEqual(endpoints(upstream.calls), ["catalogue/tables"]);
});

test("browseCatalogue: Status 104 with an empty list is empty; an exact code without * is told to add one", async () => {
  const { client } = clientFor(() => jsonResponse({ ...EMPTY_104("catalogue", "tables"), List: [] }));
  const result = await browseCatalogue(client, { selection: "12411" });
  assert.equal(result.status, "empty");
  if (result.status !== "empty") return;
  assert.match(result.reason, /12411\*/);
});

test("browseCatalogue: a list as long as the limit is not complete (GENESIS has no paging)", async () => {
  const { client } = clientFor(() => jsonResponse(TABLES_12411));
  const result = await browseCatalogue(client, { selection: "12411*", limit: 3, searchIn: "code", sortBy: "title" });
  assert.equal(result.status === "ok" && result.complete, false);
});

test("describeObject: title, regional depth, time span and the dimensions (the regional variable among them)", async () => {
  const { client, upstream } = clientFor(() => jsonResponse(METADATA_12411_01_01_4));
  const result = await describeObject(client, { code: "12411-01-01-4" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.regionalDepth, "Kreise und krfr. Städte");
  assert.deepEqual(result.timeSpan, { from: "1995", to: "2023" });
  assert.deepEqual(result.dimensions, [
    { code: "KREISE", title: "Kreise und kreisfreie Städte", role: "head", type: "Merkmal", values: 400 },
    { code: "GES", title: "Geschlecht", role: "column", type: "Merkmal", values: 2 },
    { code: "BEVSTD", title: "Bevölkerungsstand", role: "column", type: "Wert", values: -1 },
    { code: "STAG", title: "Stichtag", role: "row", type: "Merkmal", values: 29 },
  ]);
  assert.deepEqual(endpoints(upstream.calls), ["metadata/table"]);
});

test("describeObject: a code that doesn't exist (Status 104, no Object) is empty, not an error", async () => {
  const { client } = clientFor(() => jsonResponse(EMPTY_104("metadata", "table")));
  const result = await describeObject(client, { code: "12411" });
  assert.equal(result.status, "empty");
  if (result.status !== "empty") return;
  assert.match(result.reason, /Codes are exact/);
});

test("getFlatTable: the ffcsv download is unpacked from its ZIP and split into columns and rows; keys stay text", async () => {
  const { client, upstream } = clientFor(() => rawResponse(zipOf({ "12411-01-01-4_flat.csv": FFCSV_12411_01_01_4 }), "application/zip"));
  const result = await getFlatTable(client, { code: "12411-01-01-4", regionKey: "08221", startYear: "2022" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.file, "12411-01-01-4_flat.csv");
  assert.equal(result.columns[9], "value");
  assert.equal(result.total, 2);
  assert.equal(result.rows[1]?.[9], "162273");
  assert.equal(result.rows[1]?.[7], "08221");
  assert.equal(result.rows[1]?.[4], "2023-12-31");
  const body = bodyOf(upstream.last());
  assert.equal(body.get("format"), "ffcsv");
  assert.equal(body.get("regionalkey"), "08221");
  assert.equal(body.get("startyear"), "2022");
  assert.deepEqual(endpoints(upstream.calls), ["data/tablefile"]);
});

test("getFlatTable and fetchData: a line break inside a quoted cell stays in the cell, the row whole", async () => {
  const csv = 'time;1_variable_attribute_code;1_variable_attribute_label;value\r\n31.12.2023;08221;"Heidelberg,\nStadtkreis";162.273\r\n31.12.2023;08222;"Mannheim";315.554\r\n';
  const flat = clientFor(() => rawResponse(zipOf({ "t.csv": csv }), "application/zip"));
  const table = await getFlatTable(flat.client, { code: "12411-01-01-4" });
  assert.equal(table.status, "ok");
  if (table.status !== "ok") return;
  assert.equal(table.total, 2);
  assert.deepEqual(table.rows, [["31.12.2023", "08221", "Heidelberg,\nStadtkreis", "162.273"], ["31.12.2023", "08222", "Mannheim", "315.554"]]);
  const data = clientFor(() => jsonResponse(genesis("data", "table", { Object: { Code: "12411-01-01-4", Content: csv } })));
  const lines = await fetchData(data.client, { code: "12411-01-01-4" });
  assert.equal(lines.status, "ok");
  if (lines.status !== "ok") return;
  assert.equal(lines.total, 3);
  assert.deepEqual(lines.lines[1], ["31.12.2023", "08221", "Heidelberg,\nStadtkreis", 162273]);
});

test("getFlatTable: a quote that never closes doesn't swallow the rest of the file: the lines are split as they come", async () => {
  const { client } = clientFor(() => rawResponse(zipOf({ "t.csv": 'code;label\n1;"open\n2;b\n3;c\n' }), "application/zip"));
  const result = await getFlatTable(client, { code: "12411-01-01-4" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.total, 3);
  assert.deepEqual(result.rows[2], ["3", "c"]);
});

test("getFlatTable: a Latin-1 file is decoded; a stored (uncompressed) entry and paging work", async () => {
  const latin1 = Buffer.from("code;label\n1;Bevölkerung\n2;Größe\n", "latin1");
  const { client } = clientFor(() => rawResponse(zipOf({ "t.csv": latin1 }, { stored: true }), "application/zip"));
  const result = await getFlatTable(client, { code: "12411-01-01-4", offset: 1, limit: 1 });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.rows, [["2", "Größe"]]);
  assert.equal(result.total, 2);
});

test("getFlatTable: a download that finds nothing (Status 104 instead of a file) is empty, with the reason", async () => {
  const { client } = clientFor((endpoint) => (endpoint === "catalogue/tables" ? jsonResponse(TABLES_12411) : jsonResponse(EMPTY_104("data", "tablefile"))));
  const result = await getFlatTable(client, { code: "12411-01-01-4", startYear: "1800" });
  assert.equal(result.status, "empty");
  if (result.status !== "empty") return;
  assert.match(result.reason, /selection excluded every value/);
});

test("readZip: an entry larger than the cap, an encrypted entry and something that isn't a ZIP are parse errors", () => {
  assert.throws(() => readZip(zipOf({ "big.csv": "x".repeat(2000) }), 1000), (err: unknown) => err instanceof RegionalstatistikParseError && /more than this client reads/.test(err.message));
  const encrypted = zipOf({ "a.csv": "a" });
  encrypted.writeUInt16LE(0x801, encrypted.length - 22 - 46 - 5 + 8);
  assert.throws(() => readZip(encrypted), /encrypted/);
  assert.throws(() => readZip(Buffer.from("PK\u0003\u0004 not really")), RegionalstatistikParseError);
  assert.deepEqual(readZip(zipOf({ "dir/": "", "a.csv": "a;b" })).map((e) => e.name), ["a.csv"]);
});

test("fetchData: GENESIS's 'object not found' (Status 90) is empty too, naming the code", async () => {
  const { client } = clientFor(() => jsonResponse({ ...EMPTY_104("data", "table"), Status: { Code: 90, Content: "Der angeforderte Wert wurde nicht gefunden.", Type: "Fehler" } }));
  const result = await fetchData(client, { code: "12411-99-99-4" });
  assert.equal(result.status, "empty");
  if (result.status !== "empty") return;
  assert.match(result.reason, /no table with the code 12411-99-99-4/);
});

test("an HTML 404 without a GENESIS status (a moved path, a proxy) is the client's error, never 'no such object'", async () => {
  const page = () => rawResponse("<!DOCTYPE html><html><body><h1>HTTP Status 404 – Not Found</h1></body></html>", "text/html", 404);
  const isBare404 = (err: unknown) => err instanceof RegionalstatistikApiError && err.httpStatus === 404 && err.code === undefined;
  await assert.rejects(fetchData(clientFor(page).client, { code: "12411-01-01-4", regionKey: "08221" }), isBare404);
  await assert.rejects(getFlatTable(clientFor(page).client, { code: "12411-01-01-4" }), isBare404);
  await assert.rejects(describeObject(clientFor(page).client, { code: "12411-01-01-4" }), isBare404);
  // The data answered "nothing" (104), but the catalogue that tells why is not found itself.
  const { client } = clientFor((endpoint) => (endpoint.startsWith("catalogue/") ? page() : jsonResponse(EMPTY_104("data", "table"))));
  await assert.rejects(fetchData(client, { code: "12411-01-01-4", regionKey: "08221" }), isBare404);
});

test("a refused login is never 'nothing found': wrong credentials (HTTP 404 with GENESIS code 2) stay the client's auth error", async () => {
  const { client } = clientFor(() => jsonResponse(BAD_LOGIN, 404));
  for (const run of [
    () => fetchData(client, { code: "12411-01-01-4" }),
    () => getFlatTable(client, { code: "12411-01-01-4" }),
    () => describeObject(client, { code: "12411-01-01-4" }),
    () => browseCatalogue(client, { selection: "12411*" }),
  ]) {
    await assert.rejects(run(), (err: unknown) => err instanceof RegionalstatistikApiError && err.isAuthError && !err.isNotFound);
  }
});

test("a login GENESIS doesn't recognise (HTTP 401, code 15, as recorded live) is an auth error too", async () => {
  const { client } = clientFor(() => jsonResponse(NOT_AUTHORIZED, 401));
  await assert.rejects(findStatistics(client, { term: "Bevölkerung" }), (err: unknown) => err instanceof RegionalstatistikApiError && err.isAuthError);
});
