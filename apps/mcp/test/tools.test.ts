// This server's tools against a mock GENESIS (helpers.ts, answers from the client's
// test/recorded.ts), with the skills' traps as cases: each tool answers through the protocol (its
// structuredContent checked by the SDK against its output schema), an empty answer says why, a
// refused login is a tool error that says what to check. Then the login itself (api.ts's
// findCredentials): from the environment or the credentials file, one login from one place, never in
// a record, a result or an error. The rules every server follows are the conformance tests (M1–M12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCredentials, type HttpRequest } from "../src/mcp/api.js";
import { listTools } from "../src/mcp/server.js";
import { INSTRUCTIONS, LICENCE } from "../src/mcp/tools.js";
import { PROGRAM } from "../src/mcp/version.js";
import { connect, noUpstream, recorder } from "./harness.js";
import { BAD_LOGIN, bodyOf, endpointOf, EMPTY_104, FIND_ALL, FIND_NONE, genesis, jsonResponse, mockGenesis, TEST_TOKEN } from "./helpers.js";

const records = (lines: string[]) => lines.join("\n");

test("five tools: the use cases first, then the generic ones; descriptions and instructions within 2000 characters", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["fetchData", "findStatistics", "getFlatTable", "describeObject", "browseCatalogue"]);
  for (const tool of listTools()) assert.ok(tool.description.length <= 2000, `${tool.name}: ${tool.description.length}`);
  assert.ok(INSTRUCTIONS.length <= 2000, String(INSTRUCTIONS.length));
  assert.match(LICENCE, /dl-de\/by-2-0/);
  assert.match(LICENCE, /Statistische Ämter des Bundes und der Länder, Regionaldatenbank Deutschland/);
});

test("fetchData: the CSV decoded, German numbers as numbers, region keys as text; source names the request, never the login", async () => {
  const upstream = mockGenesis();
  const connection = await connect({ transport: upstream });
  const result = await connection.call("fetchData", { code: "12411-01-01-4", regionKey: "08221,11000", startYear: "2023", classVariable1: "GES", classKey1: "GESW" });
  const answer = result.structuredContent ?? {};
  assert.equal(answer["status"], "ok", result.content[0]?.text);
  assert.deepEqual((answer["lines"] as unknown[][])[5], ["31.12.2023", "08221", "Heidelberg, Stadtkreis", 162273, 78935, 83338]);
  assert.deepEqual((answer["lines"] as unknown[][])[7]?.slice(0, 2), ["31.12.2023", "11000"]);
  assert.equal(
    answer["source"],
    "https://www.regionalstatistik.de/genesisws/rest/2020/data/table?name=12411-01-01-4&startyear=2023&regionalkey=08221%2C11000&classifyingvariable1=GES&classifyingkey1=GESW",
  );
  assert.equal(bodyOf(upstream.last()).get("regionalkey"), "08221,11000");
  assert.match(String(answer["copyright"]), /Statistische Ämter des Bundes und der Länder/);
  assert.match(String(answer["licence"]), /dl-de\/by-2-0/);
  assert.equal(upstream.last().headers?.["username"], TEST_TOKEN, "the token goes in GENESIS's username header");
  assert.ok(!JSON.stringify(result).includes(TEST_TOKEN));
  await connection.close();
});

test("fetchData: a code GENESIS doesn't know is empty, checked against the catalogue; for a listed code the selection is blamed", async () => {
  const upstream = mockGenesis({ "data/table": () => jsonResponse(EMPTY_104("data", "table")) });
  const connection = await connect({ transport: upstream });
  const missing = await connection.call("fetchData", { code: "99999-99-99-4" });
  assert.equal(missing.structuredContent?.["status"], "empty");
  assert.match(String(missing.structuredContent?.["reason"]), /no table with the code 99999-99-99-4/);
  assert.deepEqual(upstream.calls.map(endpointOf), ["data/table", "catalogue/tables"]);
  const excluded = await connection.call("fetchData", { code: "12411-01-01-4", regionKey: "8221" });
  assert.equal(excluded.structuredContent?.["status"], "empty");
  assert.match(String(excluded.structuredContent?.["reason"]), /selection excluded every value: check the region key \(a Kreis has 5 digits/);
  await connection.close();
});

test("fetchData: too large (Status 98) is a tool error that names this tool's arguments, not the CLI's options", async () => {
  const tooLarge = genesis("data", "table", {}, { Code: 98, Content: "Die Tabelle ist zu groß für einen direkten Abruf.", Type: "Information" });
  const connection = await connect({ transport: mockGenesis({ "data/table": tooLarge }) });
  const result = await connection.call("fetchData", { code: "12411-01-01-5" });
  assert.equal(result.isError, true);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /GENESIS status 98: the object is too large/);
  assert.match(text, /Narrow it: regionKey first/);
  assert.doesNotMatch(text, /--start-year|--region-key|--class-key/);
  await connection.close();
});

test("fetchData: a class key without its variable and a wildcard code are tool errors before any request", async () => {
  const upstream = mockGenesis();
  const connection = await connect({ transport: upstream });
  const keyOnly = await connection.call("fetchData", { code: "12411-01-01-4", classKey2: "GESW" });
  assert.equal(keyOnly.isError, true);
  assert.match(keyOnly.content[0]?.text ?? "", /classKey2 needs classVariable2/);
  const wildcard = await connection.call("fetchData", { code: "12411*" });
  assert.equal(wildcard.isError, true);
  assert.match(wildcard.content[0]?.text ?? "", /exact/);
  assert.equal(upstream.calls.length, 0);
  await connection.close();
});

test("fetchData: more lines than the limit give nextOffset", async () => {
  const connection = await connect({ transport: mockGenesis() });
  const result = await connection.call("fetchData", { code: "12411-01-01-4", limit: 5 });
  assert.equal(result.structuredContent?.["nextOffset"], 5);
  assert.equal((result.structuredContent?.["lines"] as unknown[]).length, 5);
  const last = await connection.call("fetchData", { code: "12411-01-01-4", offset: 5, limit: 5 });
  assert.equal(last.structuredContent?.["nextOffset"], undefined);
  await connection.close();
});

test("findStatistics: codes and titles; no hit is empty with what was searched", async () => {
  const connection = await connect({ transport: mockGenesis({ "find/find": (request) => jsonResponse(bodyOf(request).get("term") === "Bevölkerungsstand" ? FIND_ALL : FIND_NONE) }) });
  const found = await connection.call("findStatistics", { term: "Bevölkerungsstand", category: "all", limit: 2 });
  assert.equal(found.structuredContent?.["status"], "ok", found.content[0]?.text);
  const matches = found.structuredContent?.["matches"] as { code: string; regionalDepth?: string }[];
  assert.equal(matches.length, 5);
  assert.deepEqual(matches.slice(0, 2).map((m) => m.regionalDepth), ["Kreise und krfr. Städte", "Gemeinden"], "each table's regional depth, to match the question");
  assert.equal(found.structuredContent?.["source"], "https://www.regionalstatistik.de/genesisws/rest/2020/find/find?term=Bev%C3%B6lkerungsstand&category=all&pagelength=2");
  const none = await connection.call("findStatistics", { term: "Xyzzyquux" });
  assert.equal(none.structuredContent?.["status"], "empty");
  assert.deepEqual(none.structuredContent?.["searched"], { term: "Xyzzyquux", category: "tables" });
  await connection.close();
});

test("getFlatTable: the flat CSV unpacked from the download's ZIP, as columns and rows", async () => {
  const upstream = mockGenesis();
  const connection = await connect({ transport: upstream });
  const result = await connection.call("getFlatTable", { code: "12411-01-01-4", regionKey: "08221" });
  const answer = result.structuredContent ?? {};
  assert.equal(answer["status"], "ok", result.content[0]?.text);
  assert.equal(answer["file"], "12411-01-01-4_flat.csv");
  assert.equal((answer["columns"] as string[])[9], "value");
  assert.equal(answer["total"], 2);
  assert.equal((answer["rows"] as string[][])[1]?.[7], "08221");
  assert.equal(bodyOf(upstream.last()).get("format"), "ffcsv");
  assert.match(String(answer["source"]), /\/genesisws\/rest\/2020\/data\/tablefile\?name=12411-01-01-4&regionalkey=08221&format=ffcsv$/);
  const missing = await connection.call("getFlatTable", { code: "99999-99-99-4" });
  assert.equal(missing.structuredContent?.["status"], "empty");
  await connection.close();
});

test("describeObject: the dimensions and the time span; a missing code is empty", async () => {
  const connection = await connect({ transport: mockGenesis() });
  const result = await connection.call("describeObject", { code: "12411-01-01-4" });
  assert.equal(result.structuredContent?.["status"], "ok", result.content[0]?.text);
  assert.deepEqual(result.structuredContent?.["timeSpan"], { from: "1995", to: "2023" });
  assert.equal(result.structuredContent?.["regionalDepth"], "Kreise und krfr. Städte");
  assert.deepEqual((result.structuredContent?.["dimensions"] as { code: string }[]).map((d) => d.code), ["KREISE", "GES", "BEVSTD", "STAG"]);
  const missing = await connection.call("describeObject", { code: "12411" });
  assert.equal(missing.structuredContent?.["status"], "empty");
  await connection.close();
});

test("browseCatalogue: a code pattern; nothing matched is empty with the hint to add *", async () => {
  const connection = await connect({ transport: mockGenesis({ "catalogue/statistics": { ...EMPTY_104("catalogue", "statistics"), List: [] } }) });
  const tables = await connection.call("browseCatalogue", { selection: "12411*" });
  assert.equal(tables.structuredContent?.["status"], "ok", tables.content[0]?.text);
  assert.equal((tables.structuredContent?.["items"] as unknown[]).length, 3);
  assert.equal(tables.structuredContent?.["complete"], true);
  const none = await connection.call("browseCatalogue", { selection: "99999", kind: "statistics" });
  assert.equal(none.structuredContent?.["status"], "empty");
  assert.match(String(none.structuredContent?.["reason"]), /99999\*/);
  await connection.close();
});

test("a refused login (HTTP 404 with GENESIS code 2) is a tool error saying what to check, never 'not found'", async () => {
  const bad = jsonResponse(BAD_LOGIN, 404);
  const connection = await connect({ transport: mockGenesis({ "data/table": () => bad, "metadata/table": () => bad }) });
  for (const [tool, args] of [["fetchData", { code: "12411-01-01-4" }], ["describeObject", { code: "12411-01-01-4" }]] as const) {
    const result = await connection.call(tool, args);
    assert.equal(result.isError, true, tool);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /The Regionaldatenbank refused the server's login\. Don't retry/, tool);
    assert.doesNotMatch(text, /not found|no table/i, tool);
    assert.match(text, /REGIONALSTATISTIK_API_TOKEN/);
    assert.ok(!text.includes(TEST_TOKEN));
  }
  await connection.close();
});

// --- The login (api.ts's findCredentials) ---------------------------------------------------

/** A credentials file like `regstat config set` writes, in a fresh XDG_CONFIG_HOME. */
function storedLogin(values: Record<string, string>, mode = 0o600): { env: Record<string, string>; path: string; done: () => void } {
  const home = mkdtempSync(join(tmpdir(), "regstat-mcp-"));
  const dir = join(home, "regionalstatistik");
  mkdirSync(dir, { mode: 0o700 });
  const path = join(dir, "credentials");
  writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
  chmodSync(path, mode);
  return { env: { XDG_CONFIG_HOME: home }, path, done: () => rmSync(home, { recursive: true, force: true }) };
}

const context = (env: Record<string, string | undefined>, credentialsFile = false) => ({ env, credentialsFile, transport: noUpstream, timeoutMs: 1000, userAgent: "test", maxResponseBytes: 1000 });

test("the login: a token from REGIONALSTATISTIK_API_TOKEN, or a username and password from their variables; where it came from, never the value", async () => {
  const token = await findCredentials(context({ REGIONALSTATISTIK_API_TOKEN: "env-token-0123456789abcdef0123" }));
  assert.deepEqual(token.clientOptions, { token: "env-token-0123456789abcdef0123" });
  assert.equal(token.source, "the GENESIS token from REGIONALSTATISTIK_API_TOKEN");
  const pair = await findCredentials(context({ REGIONALSTATISTIK_USERNAME: "TESTUSER12", REGIONALSTATISTIK_PASSWORD: "pass word with spaces" }));
  assert.deepEqual(pair.clientOptions, { username: "TESTUSER12", password: "pass word with spaces" }, "a password is used exactly as given, inner spaces kept");
  assert.deepEqual(pair.secrets, ["TESTUSER12", "pass word with spaces"]);
  assert.equal(pair.source, "the GENESIS username and password from REGIONALSTATISTIK_USERNAME and REGIONALSTATISTIK_PASSWORD");
});

test("the login: one login from one place; a token with a password, half a pair and an unsendable value are errors naming the variable, never the value", async () => {
  await assert.rejects(findCredentials(context({ REGIONALSTATISTIK_API_TOKEN: "t0123456789abcdef", REGIONALSTATISTIK_PASSWORD: "secret-password-1" })), /one login only/);
  await assert.rejects(findCredentials(context({ REGIONALSTATISTIK_USERNAME: "TESTUSER12" })), /gives a username but no password.*Set REGIONALSTATISTIK_PASSWORD too/);
  await assert.rejects(findCredentials(context({ REGIONALSTATISTIK_PASSWORD: "secret-password-1" })), (err: unknown) => err instanceof Error && /no username/.test(err.message) && !err.message.includes("secret-password-1"));
  await assert.rejects(
    findCredentials(context({ REGIONALSTATISTIK_API_TOKEN: "bad\ntoken-0123456789" })),
    (err: unknown) => err instanceof Error && /^REGIONALSTATISTIK_API_TOKEN cannot be sent: .*Fix REGIONALSTATISTIK_API_TOKEN\./.test(err.message) && !err.message.includes("token-0123456789"),
  );
  // An environment variable wins whole: the file is not read for the missing half.
  const file = storedLogin({ password: "stored-password-1" });
  try {
    await assert.rejects(findCredentials(context({ ...file.env, REGIONALSTATISTIK_USERNAME: "TESTUSER12" }, true)), /not read while a REGIONALSTATISTIK_\* variable is set/);
  } finally {
    file.done();
  }
});

test("the login: no variable, the credentials file (bin only); a file others can read is refused naming the fix; none at all names every way", async () => {
  const file = storedLogin({ token: "stored-token-0123456789abcdef01" });
  try {
    assert.equal((await findCredentials(context(file.env, false)).catch((err: Error) => err.message)).toString().includes("No GENESIS login"), true, "a test (credentialsFile false) never reads it");
    const found = await findCredentials(context(file.env, true));
    assert.deepEqual(found.clientOptions, { token: "stored-token-0123456789abcdef01" });
    assert.equal(found.source, `the GENESIS token stored in ${file.path} (regstat config)`);
  } finally {
    file.done();
  }
  const open = storedLogin({ token: "stored-token-0123456789abcdef01" }, 0o644);
  try {
    await assert.rejects(findCredentials(context(open.env, true)), /can be read by others \(mode 644\).*chmod 600/);
  } finally {
    open.done();
  }
  const both = storedLogin({ token: "stored-token-0123456789abcdef01", username: "TESTUSER12", password: "stored-password-1" });
  try {
    await assert.rejects(findCredentials(context(both.env, true)), /one login only.*regstat config unset token/);
  } finally {
    both.done();
  }
  await assert.rejects(findCredentials(context({}, false)), /No GENESIS login\. Set REGIONALSTATISTIK_API_TOKEN, or REGIONALSTATISTIK_USERNAME and REGIONALSTATISTIK_PASSWORD.*regstat config set token.*no login on its command line/);
});

test("without a login a tool call is a tool error naming what to set, and the next call looks again", async () => {
  const { log, lines } = recorder();
  const env: Record<string, string> = {};
  const connection = await connect({ transport: mockGenesis(), env, log });
  const first = await connection.call("fetchData", { code: "12411-01-01-4" });
  assert.equal(first.isError, true);
  assert.match(first.content[0]?.text ?? "", /No GENESIS login/);
  env["REGIONALSTATISTIK_USERNAME"] = "TESTUSER12";
  env["REGIONALSTATISTIK_PASSWORD"] = "pass-word-secret-42";
  const second = await connection.call("fetchData", { code: "12411-01-01-4" });
  assert.equal(second.structuredContent?.["status"], "ok", second.content[0]?.text);
  assert.match(records(lines), new RegExp(`INFO  \\[${PROGRAM}\\.config\\] using the GENESIS username and password from REGIONALSTATISTIK_USERNAME and REGIONALSTATISTIK_PASSWORD`));
  assert.ok(!records(lines).includes("pass-word-secret-42") && !records(lines).includes("TESTUSER12"), records(lines));
  await connection.close();
});

test("a username and password echoed by GENESIS never reach a result, an error or a record", async () => {
  const { log, lines } = recorder();
  const echo = (request: HttpRequest) =>
    jsonResponse(genesis("data", "table", { Object: { Code: "12411-01-01-4", Content: `Abruf durch ${request.headers?.["username"]} / ${request.headers?.["password"]}\n1;2\n` } }));
  const connection = await connect({ transport: mockGenesis({ "data/table": echo }), env: { REGIONALSTATISTIK_USERNAME: "TESTUSER12", REGIONALSTATISTIK_PASSWORD: "pass-word-secret-42" }, log });
  const result = await connection.call("fetchData", { code: "12411-01-01-4" });
  assert.equal(result.structuredContent?.["status"], "ok", result.content[0]?.text);
  const shown = JSON.stringify(result);
  assert.ok(!shown.includes("pass-word-secret-42") && !shown.includes("TESTUSER12"), shown);
  assert.match(shown, /Abruf durch \*\*\* \/ \*\*\*/);
  assert.ok(!records(lines).includes("pass-word-secret-42"));
  await connection.close();
});

test("the login: a password with surrounding spaces no header can carry is refused, not trimmed into another password", async () => {
  await assert.rejects(
    findCredentials(context({ REGIONALSTATISTIK_USERNAME: "TESTUSER12", REGIONALSTATISTIK_PASSWORD: " padded-password " })),
    (err: unknown) => err instanceof Error && /^REGIONALSTATISTIK_PASSWORD cannot be sent: has leading or trailing whitespace/.test(err.message) && !err.message.includes("padded-password"),
  );
});
