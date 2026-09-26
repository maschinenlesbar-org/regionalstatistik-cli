import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, redactUrl } from "../src/client/engine.js";
import {
  RegionalstatistikApiError,
  RegionalstatistikNetworkError,
  RegionalstatistikParseError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, bodyOf } from "./helpers.js";
import * as fx from "./fixtures.js";

// Built via char codes so no raw control bytes ever appear in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

test("buildUrl normalises the path (parameters travel in the body)", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("api/"), "https://example.test/api/");
  assert.equal(e.buildUrl("/x"), "https://example.test/x");
});

test("postJson sends POST with credential headers and a form-urlencoded body", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.tablesList));
  const e = new RequestEngine({ transport: mt.transport });
  await e.postJson("/catalogue/tables", { selection: "12411*", pagelength: 2 }, { username: "TOK" });
  const req = mt.last();
  assert.equal(req.method, "POST");
  assert.equal(req.headers?.["username"], "TOK");
  assert.equal(req.headers?.["Content-Type"], "application/x-www-form-urlencoded; charset=UTF-8");
  const body = bodyOf(req);
  assert.equal(body.get("selection"), "12411*");
  assert.equal(body.get("pagelength"), "2");
  // The URL carries no query string / no credentials.
  assert.equal(new URL(req.url).search, "");
});

test("Content-Length is set even for an empty POST body (avoids GENESIS 411)", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.loginOk));
  const e = new RequestEngine({ transport: mt.transport });
  await e.postJson("/helloworld/logincheck", {}, { username: "TOK" });
  assert.equal(mt.last().headers?.["Content-Length"], "0");
});

test("getJson performs an unauthenticated GET (whoami)", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.whoami));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/helloworld/whoami"), fx.whoami);
  assert.equal(mt.last().method, "GET");
  assert.equal(mt.last().headers?.["username"], undefined);
});

test("postJson throws RegionalstatistikParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.postJson("/x", {}, {}), RegionalstatistikParseError);
});

test("surfaces a logical error (Status.Type Fehler) despite HTTP 200", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.genericError)); // HTTP 200
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}, {}),
    (err) => err instanceof RegionalstatistikApiError && err.code === -1 && err.httpStatus === undefined,
  );
});

test("maps the flat (envelope-less) Code 15 auth error despite HTTP 200", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.flatNotAuthorized)); // HTTP 200, no envelope
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/catalogue/tables", { selection: "12411*" }, {}),
    (err) => {
      assert.ok(err instanceof RegionalstatistikApiError);
      assert.equal(err.code, 15);
      assert.equal(err.httpStatus, undefined);
      assert.ok(err.isAuthError);
      assert.match(err.message, /GENESIS status 15/);
      assert.match(err.message, /nicht berechtigt/);
      return true;
    },
  );
});

test("maps the flat Code 2 wrong-credentials error", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.flatBadCredentials));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/catalogue/tables", {}, { username: "U", password: "P" }),
    (err) => err instanceof RegionalstatistikApiError && err.code === 2 && /Nutzernamen/.test(err.message),
  );
});

test("a 401 with a flat Code 15 body carries both the HTTP status and the GENESIS code", async () => {
  // The live server's actual missing-credentials reply (verified 2026-07-13).
  const mt = makeMockTransport(() => rawResponse(JSON.stringify(fx.flatNotAuthorized), "application/json", 401));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/catalogue/tables", {}, {}),
    (err) => {
      assert.ok(err instanceof RegionalstatistikApiError);
      assert.equal(err.httpStatus, 401);
      assert.equal(err.code, 15);
      assert.ok(err.isAuthError);
      assert.match(err.message, /GENESIS status 15/);
      assert.match(err.message, /nicht berechtigt/);
      return true;
    },
  );
});

test("a 404 with a flat Code 2 body is bad credentials, NOT not-found", async () => {
  // The live server answers wrong credentials with HTTP 404 + { Code: 2 } —
  // isNotFound must not fire (that would exit 4 and hide the real problem).
  const mt = makeMockTransport(() => rawResponse(JSON.stringify(fx.flatBadCredentials), "application/json", 404));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/catalogue/tables", {}, { username: "U", password: "P" }),
    (err) => {
      assert.ok(err instanceof RegionalstatistikApiError);
      assert.equal(err.httpStatus, 404);
      assert.equal(err.code, 2);
      assert.ok(!err.isNotFound);
      assert.match(err.message, /Nutzernamen/);
      return true;
    },
  );
});

test("a flat non-error body (whoami shape) is returned as-is", async () => {
  // whoami has no Code/Type at all; logincheck has a *string* Status. Neither
  // may trip the flat-error mapping.
  const mt = makeMockTransport(() => jsonResponse(fx.loginOk));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.postJson("/helloworld/logincheck", {}, {}), fx.loginOk);
});

test("maps Status.Code 90 to a not-found error", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.notFound));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}, {}),
    (err) => err instanceof RegionalstatistikApiError && err.code === 90 && err.isNotFound,
  );
});

test("explains Status.Code 98 (too large) with narrowing guidance", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.tooLarge));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}, {}),
    (err) =>
      err instanceof RegionalstatistikApiError && err.code === 98 && /narrow the selection/.test(err.message),
  );
});

test("treats Status.Code 104 as a valid empty result (no throw)", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.emptyResult));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.postJson("/x", {}, {}), fx.emptyResult);
});

test("returns normally on a warning (Status.Code 22)", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.warning));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.postJson("/x", {}, {}), fx.warning);
});

test("a 503 is retried up to maxRetries then surfaces as an HTTP RegionalstatistikApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(
    () => e.postJson("/x", {}, {}),
    (err) => err instanceof RegionalstatistikApiError && err.httpStatus === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a GET to an authenticated endpoint surfaces the server's 405 (POST-only API)", async () => {
  // regionalstatistik.de answers HTTP 405 to a GET on any authenticated
  // endpoint (verified live) — it must surface as a typed HTTP error, unretried.
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return rawResponse("", "text/html", 405);
  });
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/catalogue/tables"),
    (err) => err instanceof RegionalstatistikApiError && err.httpStatus === 405,
  );
  assert.equal(calls, 1);
});

test("a 3xx is NOT followed (would forward credential headers) and surfaces as an error", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return {
      status: 307,
      headers: { location: "https://www.regionalstatistik.de/x" },
      body: Buffer.alloc(0),
    };
  });
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}, { username: "TOK" }),
    (err) => err instanceof RegionalstatistikApiError && err.httpStatus === 307 && /canonical host/.test(err.message),
  );
  assert.equal(calls, 1); // never followed the redirect
});

test("surfaces a non-JSON (plain-text) HTTP error body as the error detail", async () => {
  const mt = makeMockTransport(() =>
    rawResponse('Cannot read the array length because "pDirectory" is null', "text/plain", 500),
  );
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/find/find", {}, { username: "TOK" }),
    (err) => err instanceof RegionalstatistikApiError && err.httpStatus === 500 && /pDirectory/.test(err.message),
  );
});

test("strips terminal control characters from a plain-text error detail", async () => {
  const hostile = `boom${ESC}[31m${BEL} injected`;
  const mt = makeMockTransport(() => rawResponse(hostile, "text/plain", 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/find/find", {}, { username: "TOK" }),
    (err) => {
      assert.ok(err instanceof RegionalstatistikApiError);
      assert.ok(!err.message.includes(ESC), "ESC survived into the message");
      assert.ok(!err.message.includes(BEL), "BEL survived into the message");
      assert.match(err.message, /boom.*injected/);
      return true;
    },
  );
});

test("strips terminal control characters from a logical Status.Content", async () => {
  const body = { Status: { Code: 90, Type: "Fehler", Content: `clean${ESC}text` } };
  const mt = makeMockTransport(() => jsonResponse(body));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}, { username: "TOK" }),
    (err) => err instanceof RegionalstatistikApiError && !err.message.includes(ESC) && /cleantext/.test(err.message),
  );
});

test("strips terminal control characters from the echoed Content-Type", async () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const mt = makeMockTransport(() => rawResponse(zip, `application/zip${ESC}[31m`));
  const e = new RequestEngine({ transport: mt.transport });
  const res = await e.postRaw("/data/tablefile", "application/zip", { name: "1" }, { username: "TOK" });
  assert.ok(!res.contentType.includes(ESC));
  assert.equal(res.contentType, "application/zip[31m");
});

test("does not surface an HTML error page as the detail (noise)", async () => {
  const mt = makeMockTransport(() => rawResponse("<html><body>502 Bad Gateway</body></html>", "text/html", 502));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/find/find", {}, { username: "TOK" }),
    (err) => err instanceof RegionalstatistikApiError && err.httpStatus === 502 && err.detail === undefined,
  );
});

test("does not surface a BOM-prefixed HTML error page as the detail (regionalstatistik 404 page)", async () => {
  // The live host serves its HTML error pages with a leading UTF-8 BOM (seen on
  // the uppercase /genesisWS 404 page); the BOM must not defeat the HTML check.
  const html = '\uFEFF<!DOCTYPE html>\n<html lang="de"><body>Fehler</body></html>';
  const mt = makeMockTransport(() => rawResponse(html, "text/html", 404));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/find/find", {}, { username: "TOK" }),
    (err) =>
      err instanceof RegionalstatistikApiError &&
      err.httpStatus === 404 &&
      err.detail === undefined &&
      err.isNotFound, // a genuine 404 without a GENESIS code still maps to not-found
  );
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.tablesList));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.postJson("/x", {}, {});
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("postRaw returns the bytes for a binary download", async () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
  const mt = makeMockTransport(() => rawResponse(zip, "application/zip"));
  const e = new RequestEngine({ transport: mt.transport });
  const res = await e.postRaw("/data/tablefile", "application/zip", { name: "1" }, { username: "TOK" });
  assert.deepEqual(res.data, zip);
});

test("postRaw surfaces a JSON logical error served on a file endpoint", async () => {
  const mt = makeMockTransport(() => rawResponse(JSON.stringify(fx.notFound), "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postRaw("/data/tablefile", "application/zip", { name: "1" }, { username: "TOK" }),
    (err) => err instanceof RegionalstatistikApiError && err.code === 90,
  );
});

test("postRaw surfaces a flat JSON auth error served on a file endpoint", async () => {
  const mt = makeMockTransport(() => rawResponse(JSON.stringify(fx.flatNotAuthorized), "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postRaw("/data/tablefile", "application/zip", { name: "1" }, {}),
    (err) => err instanceof RegionalstatistikApiError && err.code === 15,
  );
});

test("postRaw raises a Status.Code 104 reply on a file endpoint as not-found (no download)", async () => {
  const mt = makeMockTransport(() => rawResponse(JSON.stringify(fx.emptyResult), "application/json;charset=UTF-8"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postRaw("/data/tablefile", "application/zip", { name: "99999-99" }, { username: "TOK" }),
    (err) => {
      assert.ok(err instanceof RegionalstatistikApiError);
      assert.equal(err.code, 104);
      assert.ok(err.isNotFound);
      assert.match(err.message, /GENESIS status 104 \(Information\)/);
      assert.match(err.message, /instead of a file/);
      return true;
    },
  );
});

test("postRaw raises non-error statuses (Information, Warnung, success) — JSON is never a download", async () => {
  for (const body of [fx.warning, fx.dataTable, envelopeWith(12, "Information"), envelopeWith(5, "Warnung")]) {
    const mt = makeMockTransport(() => jsonResponse(body));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.postRaw("/data/tablefile", "application/zip", { name: "1" }, { username: "TOK" }),
      (err) => err instanceof RegionalstatistikApiError && err.code !== undefined && !err.isNotFound,
    );
  }
});

test("postRaw sniffs a GENESIS reply whatever its Content-Type, and after a BOM", async () => {
  const envelope90 = JSON.stringify(fx.notFound);
  for (const [body, type, code] of [
    [envelope90, "text/plain;charset=UTF-8", 90],
    [JSON.stringify(fx.tooLarge), "application/octet-stream", 98],
    [JSON.stringify(fx.flatBadCredentials), "text/plain", 2],
    ["\uFEFF" + envelope90, "application/json", 90],
    ["\uFEFF" + envelope90, "application/zip", 90],
  ] as const) {
    const mt = makeMockTransport(() => rawResponse(body, type));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.postRaw("/data/tablefile", "application/zip", { name: "1" }, { username: "TOK" }),
      (err) => err instanceof RegionalstatistikApiError && err.code === code,
      `${type}: ${body.slice(0, 20)}`,
    );
  }
});

test("postRaw rejects an empty body, JSON without a status and unparseable JSON", async () => {
  for (const [body, type] of [
    ["", "application/json;charset=UTF-8"],
    ["", "application/zip"],
    ['{"hello":"world"}', "application/octet-stream"],
    ["this is not json", "application/json;charset=UTF-8"],
  ] as const) {
    const mt = makeMockTransport(() => rawResponse(body, type));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.postRaw("/data/tablefile", "application/zip", { name: "1" }, { username: "TOK" }),
      RegionalstatistikParseError,
      `${type}: ${body}`,
    );
  }
});

test("postRaw returns a non-JSON body that merely starts with a brace", async () => {
  const mt = makeMockTransport(() => rawResponse("{not json;1;2\n", "text/csv"));
  const e = new RequestEngine({ transport: mt.transport });
  const res = await e.postRaw("/data/tablefile", "application/zip", { name: "1" }, { username: "TOK" });
  assert.equal(res.data.toString("utf8"), "{not json;1;2\n");
});

test("redactUrl masks username and password query parameters", () => {
  const masked = redactUrl("https://www.regionalstatistik.de/x?name=1&username=SECRET&password=HUNTER2");
  assert.match(masked, /username=%2A%2A%2A|username=\*\*\*/);
  assert.doesNotMatch(masked, /SECRET|HUNTER2/);
});

test("redactUrl masks URL userinfo (basic-auth credentials in the base URL)", () => {
  const masked = redactUrl("https://SECRETUSER:HUNTER2@www.regionalstatistik.de/x?name=1");
  assert.doesNotMatch(masked, /SECRETUSER|HUNTER2/);
  // The host and path survive; only the credentials are scrubbed.
  assert.match(masked, /www\.regionalstatistik\.de\/x/);
});

test("a base URL with embedded userinfo does not leak into the error message", async () => {
  const mt = makeMockTransport(() => rawResponse("nope", "text/plain", 500));
  const e = new RequestEngine({
    baseUrl: "https://SECRETUSER:HUNTER2@www.regionalstatistik.de",
    transport: mt.transport,
  });
  await assert.rejects(
    () => e.postJson("/find/find", {}, { username: "TOK" }),
    (err) => err instanceof RegionalstatistikApiError && !/SECRETUSER|HUNTER2/.test(err.message),
  );
});

test("rejects a non-http(s) base URL at construction, even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.whoami));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof RegionalstatistikNetworkError && /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("rejects an unparseable base URL at construction", () => {
  const mt = makeMockTransport(() => jsonResponse(fx.whoami));
  assert.throws(
    () => new RequestEngine({ baseUrl: "not a url", transport: mt.transport }),
    (err) => err instanceof RegionalstatistikNetworkError && /Invalid base URL/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test("a rejected base URL does not echo embedded credentials", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://SECRETUSER:HUNTER2@example.org" }),
    (err) => err instanceof RegionalstatistikNetworkError && !/SECRETUSER|HUNTER2/.test(err.message),
  );
});

function envelopeWith(code: number, type: string): unknown {
  return { Ident: { Service: "x", Method: "y" }, Status: { Code: code, Content: "status text", Type: type }, Parameter: {}, Copyright: "c" };
}
