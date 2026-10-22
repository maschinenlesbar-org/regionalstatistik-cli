import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RegionalstatistikClient,
  type RegionalstatistikClientOptions,
} from "../src/client.js";
import { makeMockTransport, jsonResponse, bodyOf, type MockTransport } from "./helpers.js";
import type { HttpRequest, HttpResponse } from "../src/http.js";
import * as fx from "./fixtures.js";
import { RegionalstatistikNetworkError, RegionalstatistikValidationError } from "../src/errors.js";
import { normalizeText } from "../src/validate.js";

function client(
  responder: (req: HttpRequest) => HttpResponse,
  options: Omit<RegionalstatistikClientOptions, "transport"> = {},
): { c: RegionalstatistikClient; mt: MockTransport } {
  const mt = makeMockTransport(responder);
  const c = new RegionalstatistikClient({ ...options, transport: mt.transport });
  return { c, mt };
}

test("whoami is an unauthenticated GET and sends no credential headers", async () => {
  const { c, mt } = client(() => jsonResponse(fx.whoami), { token: "TOK" });
  await c.whoami();
  const req = mt.last();
  assert.equal(req.method, "GET");
  // Lowercase `genesisws` — the uppercase destatis-style path 404s on this host.
  assert.equal(new URL(req.url).pathname, "/genesisws/rest/2020/helloworld/whoami");
  assert.equal(req.headers?.["username"], undefined);
});

test("token mode puts the token in the username header and sends no password", async () => {
  const { c, mt } = client(() => jsonResponse(fx.tablesList), { token: "0123456789abcdef" });
  await c.catalogue.tables({ selection: "12411*" });
  const req = mt.last();
  assert.equal(req.method, "POST");
  assert.equal(req.headers?.["username"], "0123456789abcdef");
  assert.equal(req.headers?.["password"], undefined);
  assert.equal(bodyOf(req).get("selection"), "12411*");
  assert.equal(new URL(req.url).pathname, "/genesisws/rest/2020/catalogue/tables");
});

test("username+password mode sends both credential headers", async () => {
  const { c, mt } = client(() => jsonResponse(fx.tablesList), {
    username: "USER123456",
    password: "PASSWORD01",
  });
  await c.catalogue.statistics({});
  assert.equal(mt.last().headers?.["username"], "USER123456");
  assert.equal(mt.last().headers?.["password"], "PASSWORD01");
});

test("a token takes precedence over username/password", async () => {
  const { c, mt } = client(() => jsonResponse(fx.tablesList), {
    token: "THETOKEN",
    username: "USER123456",
    password: "PASSWORD01",
  });
  await c.catalogue.tables({});
  assert.equal(mt.last().headers?.["username"], "THETOKEN");
  assert.equal(mt.last().headers?.["password"], undefined);
});

test("find posts term and category in the body to find/find", async () => {
  const { c, mt } = client(() => jsonResponse(fx.findResult), { token: "T" });
  await c.find({ term: "Bevölkerung Kreise", category: "tables" });
  const req = mt.last();
  assert.equal(new URL(req.url).pathname, "/genesisws/rest/2020/find/find");
  assert.equal(bodyOf(req).get("term"), "Bevölkerung Kreise");
  assert.equal(bodyOf(req).get("category"), "tables");
});

test("metadata.table posts the object name to metadata/table", async () => {
  const { c, mt } = client(() => jsonResponse(fx.metadataTable), { token: "T" });
  await c.metadata.table("12411-01-01-4");
  assert.equal(new URL(mt.last().url).pathname, "/genesisws/rest/2020/metadata/table");
  assert.equal(bodyOf(mt.last()).get("name"), "12411-01-01-4");
});

test("data.table posts name and regional/selection filters to data/table", async () => {
  const { c, mt } = client(() => jsonResponse(fx.dataTable), { token: "T" });
  await c.data.table("12411-01-01-4", {
    startyear: "2020",
    regionalvariable: "KREISE",
    regionalkey: "08*",
  });
  const body = bodyOf(mt.last());
  assert.equal(new URL(mt.last().url).pathname, "/genesisws/rest/2020/data/table");
  assert.equal(body.get("name"), "12411-01-01-4");
  assert.equal(body.get("startyear"), "2020");
  assert.equal(body.get("regionalvariable"), "KREISE");
  assert.equal(body.get("regionalkey"), "08*");
});

test("data.tableFile posts to the file endpoint and returns raw bytes", async () => {
  const zip = Buffer.from([0x50, 0x4b]);
  const { c, mt } = client(
    () => ({ status: 200, headers: { "content-type": "application/zip" }, body: zip }),
    { token: "T" },
  );
  const res = await c.data.tableFile("12411-01-01-4", { format: "ffcsv" });
  assert.equal(new URL(mt.last().url).pathname, "/genesisws/rest/2020/data/tablefile");
  assert.equal(bodyOf(mt.last()).get("format"), "ffcsv");
  assert.deepEqual(res.data, zip);
});

test("a non-blank credential is sent exactly as given, never trimmed", async () => {
  const { c, mt } = client(() => jsonResponse(fx.tablesList), { username: "u", password: "pass with spaces" });
  await c.catalogue.tables({});
  assert.equal(mt.last().headers?.["password"], "pass with spaces");
});

test("a credential with surrounding whitespace is rejected, never trimmed or sent", () => {
  const mt = makeMockTransport(() => jsonResponse(fx.tablesList));
  assert.throws(
    () => new RegionalstatistikClient({ username: "u", password: " pass with spaces ", transport: mt.transport }),
    (err) =>
      err instanceof RegionalstatistikValidationError &&
      err.message === "Invalid password: Value has leading or trailing whitespace, which an HTTP header cannot carry.",
  );
  assert.equal(mt.calls.length, 0);
});

test("a blank token is treated as unset (no credential header)", async () => {
  const { c, mt } = client(() => jsonResponse(fx.loginOk), { token: "   " });
  await c.logincheck();
  assert.equal(mt.last().headers?.["username"], undefined);
});

test("an account-only endpoint without credentials rejects before any request", async () => {
  const { c, mt } = client(() => jsonResponse(fx.tablesList), { token: "   " });
  for (const call of [() => c.catalogue.tables({}), () => c.metadata.table("X"), () => c.data.table("T"), () => c.data.tableFile("T"), () => c.find({ term: "bev" })]) {
    await assert.rejects(
      call,
      (err) =>
        err instanceof RegionalstatistikValidationError &&
        err.message === "Invalid credentials: This endpoint needs an account (a token, or a username and password).",
    );
  }
  assert.equal(mt.calls.length, 0);
});

test("a non-http(s) base URL is rejected before any request carries credentials", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.whoami));
    assert.throws(
      () =>
        new RegionalstatistikClient({
          baseUrl,
          username: "USER",
          password: "PASS",
          transport: mt.transport,
        }),
      (err) => err instanceof RegionalstatistikValidationError && !(err instanceof RegionalstatistikNetworkError),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("K6: the find term goes out trimmed and in NFC; a blank one is refused before any request", async () => {
  const { c, mt } = client(() => jsonResponse(fx.findResult), { token: "TOK" });
  for (const term of ["  Bevölkerung  ", "Bevölkerung\n", "\tBevölkerung", "\u00a0Bevölkerung\u00a0", "Bevölkerung\u3000", "Bevo\u0308lkerung "]) {
    await c.find({ term });
    assert.equal(bodyOf(mt.last()).get("term"), "Bevölkerung", JSON.stringify(term));
  }
  await c.find({ term: " a  b " });
  assert.equal(bodyOf(mt.last()).get("term"), "a  b");
  // Codes go out trimmed and in NFC too (D8 of 2026-10-21; they used to be sent as given).
  await c.catalogue.tables({ selection: " 12411* " });
  assert.equal(bodyOf(mt.last()).get("selection"), "12411*");
  const before = mt.calls.length;
  for (const term of ["", " ", "\n\t", "\u00a0", "\u3000"]) {
    await assert.rejects(c.find({ term }), RegionalstatistikValidationError, JSON.stringify(term));
  }
  assert.equal(mt.calls.length, before);
  assert.equal(normalizeText("  Bevo\u0308lkerung\n"), "Bevölkerung");
});

test("text parameters and object codes are sent in Unicode NFC (P11)", async () => {
  const nfd = "Bevölkerung";
  const mt = makeMockTransport(() => jsonResponse(fx.findResult));
  const c = new RegionalstatistikClient({ token: "0123456789abcdef0123456789abcdef", transport: mt.transport });
  await c.find({ term: nfd });
  assert.equal(bodyOf(mt.last()).get("term"), "Bevölkerung");
  await c.catalogue.tables({ selection: `${nfd}*` }).catch(() => undefined);
  assert.equal(bodyOf(mt.last()).get("selection"), "Bevölkerung*");
  await c.metadata.table(nfd).catch(() => undefined);
  assert.equal(bodyOf(mt.last()).get("name"), "Bevölkerung");
});

test("a refused value is quoted visibly: an invisible or format character is escaped, never raw (D10)", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.findResult));
  const c = new RegionalstatistikClient({ token: "0123456789abcdef0123456789abcdef", transport: mt.transport });
  const zwsp = String.fromCharCode(0x200b);
  await assert.rejects(c.find({ term: "x", [`a${zwsp}b`]: "1" } as never), (err: Error) => {
    assert.ok(err instanceof RegionalstatistikValidationError);
    assert.match(err.message, /unknown parameter "a\\u200bb"/);
    assert.ok(!err.message.includes(zwsp), err.message);
    return true;
  });
  assert.equal(mt.calls.length, 0);
});

test("codes and filter values go out trimmed and in NFC, a list item by item; an invisible character is refused (D8)", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.dataTable));
  const c = new RegionalstatistikClient({ token: "0123456789abcdef0123456789abcdef", transport: mt.transport });
  await c.data.table(" 12411-0001\n", { startyear: " 2020 ", contents: " BEV001 , é ", regionalkey: "05 * " });
  const body = bodyOf(mt.calls[0]!);
  assert.equal(body.get("name"), "12411-0001");
  assert.equal(body.get("startyear"), "2020");
  assert.equal(body.get("contents"), "BEV001,é");
  assert.equal(body.get("regionalkey"), "05 *");
  for (const [name, params] of [
    ["12411​-0001", {}],
    ["12411-0001", { contents: "A,,B" }],
    ["12411-0001", { classifyingkey1: "­" }],
    ["́", {}],
  ] as const) {
    await assert.rejects(c.data.table(name, params), RegionalstatistikValidationError, name);
  }
  // Free text keeps ZWJ (an emoji sequence) and inner whitespace.
  await c.find({ term: " a‍b  c " });
  assert.equal(bodyOf(mt.calls[1]!).get("term"), "a‍b  c");
  assert.equal(mt.calls.length, 2);
});

test("a non-string term or object code is called a wrong type, not empty (01-1)", async () => {
  // A JavaScript caller passing a number (a year as term, a numeric code as name) was told the
  // value was empty; every other parameter already said "Expected a string.".
  const mt = makeMockTransport(() => jsonResponse(fx.findResult));
  const c = new RegionalstatistikClient({ token: "0123456789abcdef0123456789abcdef", transport: mt.transport });
  for (const term of [5, true, {}, ["x"]]) {
    await assert.rejects(c.find({ term } as never), (err: Error) => {
      assert.ok(err instanceof RegionalstatistikValidationError);
      assert.equal(err.message, "Invalid term: Expected a string.");
      return true;
    });
  }
  for (const call of [() => c.metadata.table(5 as never), () => c.data.table(8221 as never)]) {
    await assert.rejects(call(), (err: Error) => err instanceof RegionalstatistikValidationError && err.message === "Invalid name: Expected a string.");
  }
  assert.equal(mt.calls.length, 0);
});
