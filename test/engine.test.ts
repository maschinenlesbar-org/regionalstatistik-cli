import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRIES, MAX_RETRY_AFTER_MS, RequestEngine, cleartextProblem, parseRetryAfter, redactUrl } from "../src/client/engine.js";
import { MAX_TIMEOUT_MS } from "../src/client/http.js";
import {
  RegionalstatistikValidationError,
  RegionalstatistikApiError,
  RegionalstatistikNetworkError,
  RegionalstatistikParseError,
  cutText,
  toWellFormed,
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
  await e.postJson("/helloworld/logincheck", {}, { username: "TOK" }, "unchecked");
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

test("an empty 200 body or a 204 is a RegionalstatistikParseError, not null", async () => {
  for (const res of [rawResponse("", "application/json"), rawResponse("  \n", "application/json"), rawResponse("", "application/json", 204)]) {
    const mt = makeMockTransport(() => res);
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.postJson("/find/find", {}, {}),
      (err) => err instanceof RegionalstatistikParseError && err.message === "Empty response body from /find/find",
    );
    await assert.rejects(() => e.getJson("/helloworld/whoami"), RegionalstatistikParseError);
  }
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
      assert.equal(err.httpStatus, 200);
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
      assert.ok(err.isAuthError);
      assert.equal(err.credentialsSent, true);
      assert.match(err.message, /Nutzernamen/);
      return true;
    },
  );
});

test("a bare 404 (no GENESIS code) is still not-found", async () => {
  const mt = makeMockTransport(() => rawResponse("Not Found", "text/plain", 404));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}, {}),
    (err) => err instanceof RegionalstatistikApiError && err.isNotFound && !err.isAuthError,
  );
});

test("a flat non-error body (logincheck / whoami shape) is returned as-is where the shape is unchecked", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.loginOk));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.postJson("/helloworld/logincheck", {}, {}, "unchecked"), fx.loginOk);
  // The enveloped endpoints require the envelope (P9).
  await assert.rejects(e.postJson("/find/find", {}, {}), RegionalstatistikParseError);
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

test("a base URL with embedded userinfo is rejected at construction, without leaking it", () => {
  const mt = makeMockTransport(() => rawResponse("nope", "text/plain", 500));
  assert.throws(
    () => new RequestEngine({ baseUrl: "https://SECRETUSER:HUNTER2@www.regionalstatistik.de", transport: mt.transport }),
    (err) =>
      err instanceof RegionalstatistikValidationError &&
      err.message === "Invalid baseUrl: Must not embed credentials (user:pass@host)." &&
      !/SECRETUSER|HUNTER2/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test("a base URL with whitespace is rejected at construction, before the trailing-slash strip", () => {
  for (const baseUrl of ["https://example.test/ ", " https://example.test", "https://example.test\t", "https://example.test/a b"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.whoami));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof RegionalstatistikValidationError && /^Invalid baseUrl: A base URL cannot/.test(err.message),
      JSON.stringify(baseUrl),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("rejects a non-http(s) base URL at construction, even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.whoami));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) =>
        err instanceof RegionalstatistikValidationError &&
        !(err instanceof RegionalstatistikNetworkError) &&
        err.message === 'Invalid baseUrl: Only "http:" and "https:" URLs are allowed.',
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://example.test/?x=1", "https://example.test/#f"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (err) =>
        err instanceof RegionalstatistikValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#).",
    );
  }
});

test("rejects an unparseable base URL at construction", () => {
  const mt = makeMockTransport(() => jsonResponse(fx.whoami));
  assert.throws(
    () => new RequestEngine({ baseUrl: "not a url", transport: mt.transport }),
    (err) =>
      err instanceof RegionalstatistikValidationError && err.message === "Invalid baseUrl: Must be an absolute http(s) URL.",
  );
  assert.equal(mt.calls.length, 0);
});

test("a rejected base URL does not echo embedded credentials", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://SECRETUSER:HUNTER2@example.org" }),
    (err) => err instanceof RegionalstatistikValidationError && !/SECRETUSER|HUNTER2/.test(err.message),
  );
});

function envelopeWith(code: number, type: string): unknown {
  return { Ident: { Service: "x", Method: "y" }, Status: { Code: code, Content: "status text", Type: type }, Parameter: {}, Copyright: "c" };
}

test("credentialsSent: true with a username header, false with none, undefined for whoami", async () => {
  const mt = makeMockTransport(() => rawResponse(JSON.stringify(fx.flatNotAuthorized), "application/json", 401));
  const e = new RequestEngine({ transport: mt.transport });
  for (const [call, expected] of [
    [() => e.postJson("/x", {}, { username: "U", password: "P" }), true],
    [() => e.postJson("/x", {}, {}), false],
    [() => e.getJson("/helloworld/whoami"), undefined],
  ] as const) {
    await assert.rejects(call, (err) => err instanceof RegionalstatistikApiError && err.credentialsSent === expected);
  }
});

test("a flat Code 2 on HTTP 200 is an auth error too, like the live 404 pairing (01#2)", async () => {
  // The fixture's shape is what this host sent on HTTP 200 in July 2026.
  const mt = makeMockTransport(() => jsonResponse(fx.flatBadCredentials));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}, { username: "U", password: "P" }),
    (err) =>
      err instanceof RegionalstatistikApiError && err.code === 2 && err.httpStatus === 200 && err.isAuthError && !err.isNotFound,
  );
});

test("an enveloped Code 2 is not an auth error: only the flat shape is", async () => {
  const body = { Status: { Code: 2, Content: "x", Type: "ERROR" }, Object: null };
  const mt = makeMockTransport(() => jsonResponse(body));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/x", {}, { username: "U", password: "P" }),
    (err) => err instanceof RegionalstatistikApiError && err.code === 2 && err.httpStatus === undefined && !err.isAuthError,
  );
});

test("a non-zero Status.Code outside 0/22/50/104 is an error whatever its Type (03#3)", async () => {
  for (const type of ["Information", "Warnung", "Hinweis"]) {
    const body = { Status: { Code: 1, Content: "Parameter regionalkey ungueltig", Type: type }, Object: null };
    const mt = makeMockTransport(() => jsonResponse(body));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.postJson("/data/table", {}, { username: "U", password: "P" }),
      (err) => err instanceof RegionalstatistikApiError && err.code === 1 && !err.isNotFound && /regionalkey ungueltig/.test(err.message),
      type,
    );
  }
  for (const code of [0, 22, 50, 104]) {
    const body = { Status: { Code: code, Content: "ok", Type: code === 22 ? "Warnung" : "Information" }, Object: null };
    const mt = makeMockTransport(() => jsonResponse(body));
    const e = new RequestEngine({ transport: mt.transport });
    assert.deepEqual(await e.postJson("/data/table", {}, { username: "U", password: "P" }), body, String(code));
  }
});

test("a Status.Code sent as a numeric string is read as the number", async () => {
  const body = { Status: { Code: "90", Content: "nicht gefunden", Type: "Information" }, Object: null };
  const mt = makeMockTransport(() => jsonResponse(body));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/data/table", {}, { username: "U", password: "P" }),
    (err) => err instanceof RegionalstatistikApiError && err.code === 90 && err.isNotFound,
  );
});

test("an error Type is an error even without a numeric Code", async () => {
  const body = { Status: { Content: "kaputt", Type: "Fehler" }, Object: null };
  const mt = makeMockTransport(() => jsonResponse(body));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.postJson("/data/table", {}, { username: "U", password: "P" }),
    (err) => err instanceof RegionalstatistikApiError && err.code === undefined && /kaputt/.test(err.message),
  );
});

// ---- Retry-After ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from(JSON.stringify({ detail: "slow down" })),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("5");
  await assert.rejects(
    () => engine.postJson("/x", {}, {}),
    (e: unknown) => e instanceof RegionalstatistikApiError && e.httpStatus === 429,
  );
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [5000, 5000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.postJson("/x", {}, {}));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(
      () => engine.postJson("/x", {}, {}),
      (e: unknown) => e instanceof RegionalstatistikApiError && e.httpStatus === 429,
    );
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

// ---- numeric engine options (parity report finding #4) ------------------------------

const BAD_LIMITS: Array<[string, number]> = [
  ["timeoutMs", -1],
  ["timeoutMs", NaN],
  ["timeoutMs", 1.5],
  ["timeoutMs", Infinity],
  ["timeoutMs", MAX_TIMEOUT_MS + 1],
  ["maxRetries", -1],
  ["maxRetries", 1.5],
  ["maxRetries", Infinity],
  ["maxRetries", MAX_RETRIES + 1],
  ["maxResponseBytes", -1],
  ["maxResponseBytes", NaN],
  ["maxResponseBytes", 1.5],
  ["retryDelayMs", -1],
  ["retryDelayMs", NaN],
  // Above MAX_RETRY_AFTER_MS a backoff would overflow Node's timers and fire at once.
  ["retryDelayMs", 30_001],
];

for (const [name, value] of BAD_LIMITS) {
  test(`the engine rejects ${name}: ${value} at construction`, () => {
    assert.throws(
      () => new RequestEngine({ [name]: value }),
      (err: unknown) =>
        err instanceof RegionalstatistikValidationError && (err as Error).message.startsWith(`Invalid ${name}: `),
    );
  });
}

test("the engine accepts the boundary values of every numeric option", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.tablesList));
  const e = new RequestEngine({
    transport: mt.transport,
    timeoutMs: MAX_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    maxResponseBytes: 0,
    retryDelayMs: 0,
  });
  await e.postJson("/x", {}, {});
  assert.equal(mt.last().timeoutMs, MAX_TIMEOUT_MS);
  assert.equal(mt.last().maxResponseBytes, undefined);
  assert.doesNotThrow(() => new RequestEngine({ timeoutMs: 0, maxRetries: 0 }));
});

test("server text in an error is cut at 500 characters; the body keeps it all (P13)", async () => {
  const long = "x".repeat(5000);
  const mt = makeMockTransport(() => jsonResponse({ Status: { Code: -1, Content: long, Type: "Fehler" } }));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(e.postJson("/find/find", {}, {}), (err: unknown) => {
    assert.ok(err instanceof RegionalstatistikApiError);
    assert.equal(err.detail?.length, 501);
    assert.ok(err.message.length < 700, String(err.message.length));
    assert.ok(err.body.includes(long));
    return true;
  });
});

test("server text in an error stays on one line, without bidi overrides (result 01, question 3)", async () => {
  const content = "Ein Fehler ist aufgetreten. (Bitte prüfen ‮abc‬ Nutzernamen bzw.\n das Passwort.)\r\nError: ok";
  const mt = makeMockTransport(() => jsonResponse({ Code: 2, Content: content, Type: "ERROR" }, 404));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(e.postJson("/x", {}, { username: "U", password: "P" }), (err: unknown) => {
    assert.ok(err instanceof RegionalstatistikApiError);
    assert.doesNotMatch(err.message, /[\r\n‮‬]/);
    assert.match(err.message, /Nutzernamen bzw\. das Passwort\.\) Error: ok$/);
    return true;
  });
});

test("cleartextProblem: one sentence naming the host and the secrets, never their values", () => {
  assert.equal(cleartextProblem("https://www.regionalstatistik.de"), undefined);
  assert.equal(cleartextProblem("not a url"), undefined);
  for (const loopback of ["http://localhost:8080", "http://127.0.0.1", "http://127.8.9.10:1", "http://[::1]:9"]) {
    assert.equal(cleartextProblem(loopback, ["the token"]), undefined, loopback);
  }
  assert.equal(cleartextProblem("http://mirror.example:81"), "requests to mirror.example:81 are sent unencrypted (http:, not https:)");
  assert.equal(cleartextProblem("http://mirror.example", ["the login"]), "the login is sent unencrypted to mirror.example (http:, not https:)");
  assert.equal(
    cleartextProblem("http://u:pw-value@mirror.example", ["the token"]),
    "the token and the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)",
  );
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail cut at 500 (or a plain-text snippet at 200) characters keeps the message well-formed", async () => {
  for (const shape of ["json", "text"]) {
    for (const detail of ["a" + "\u{1f600}".repeat(400), "\u{1f600}".repeat(400)]) {
      const body = shape === "json" ? JSON.stringify({ Status: { Code: -1, Content: detail, Type: "Fehler" } }) : detail;
      const e = new RequestEngine({ transport: async () => ({ status: shape === "json" ? 200 : 500, headers: { "content-type": shape === "json" ? "application/json" : "text/plain" }, body: Buffer.from(body) }) });
      await assert.rejects(e.postJson("/find/find", {}, {}), (err: Error) => {
        assert.equal(toWellFormed(err.message), err.message, `${shape}: ${err.message.slice(-20)}`);
        assert.match(err.message, /…/);
        return true;
      });
    }
  }
});

test("own messages quote a server value at most MAX_MESSAGE_VALUE_LENGTH characters long (L3)", async () => {
  const long = "x".repeat(5000);
  // A GENESIS Status.Type of 5000 characters: the message quotes it cut.
  const typed = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ Status: { Code: 7, Content: "c", Type: `Fehler ${long}` } })) }) });
  await assert.rejects(typed.postJson("/find/find", {}, {}), (err: Error) => err.message.length < 1200 && /\(Fehler x+…\)/.test(err.message));
  // An unknown charset of 5000 characters.
  const charset = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": `application/json; charset=${long}` }, body: Buffer.from("{}") }) });
  await assert.rejects(charset.postJson("/find/find", {}, {}), (err: Error) => err.message.length < 1200 && /charset "x+…"/.test(err.message));
});

test("a long Status.Type is quoted cut in every answer shape: envelope, flat 404 and logincheck (results/03 bug 03-1)", async () => {
  const type = `Fehler ${"T".repeat(200_000)}`;
  const answers: Array<[string, number, unknown]> = [
    ["/metadata/table", 200, { Status: { Code: 90, Content: "kurz", Type: type } }],
    ["/find/find", 404, { Code: 2, Content: "kurz", Type: type }],
    ["/helloworld/logincheck", 200, { Status: { Code: 2, Content: "kurz", Type: type }, Username: "u" }],
  ];
  for (const [path, status, body] of answers) {
    const e = new RequestEngine({ transport: async () => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) }) });
    const call = path === "/helloworld/logincheck" ? e.postLoginCheck(path, {}, {}) : e.postJson(path, {}, {});
    await assert.rejects(call, (err: RegionalstatistikApiError) => {
      assert.ok(err instanceof RegionalstatistikApiError, `${path}: ${String(err)}`);
      assert.ok(err.message.length < 1200, `${path}: ${err.message.length} characters`);
      assert.match(err.message, /\(Fehler T+…\)/, path);
      assert.ok((err.statusType ?? "").length <= 501, path);
      assert.ok(String(err.body).length > 200_000, `${path}: the body keeps the whole answer`);
      return true;
    });
  }
});

test("a download's Content-Type is quoted cut in the library's own messages (results/03 bug 03-2)", async () => {
  const type = `text/html; x=${"y".repeat(5000)}`;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": type }, body: Buffer.from("<html>login</html>") }) });
  await assert.rejects(e.postRaw("/data/tablefile", "application/zip", {}, { username: "TOK" }), (err: Error) => err.message.length < 1000 && /Content-Type text\/html; x=y+…\)/.test(err.message));
});

test("a password a server echoes form-encoded (a space as +) is scrubbed from the error like its other forms (results/04 note 2)", async () => {
  const password = "Geheim 2026x";
  const echo = `Anmeldung fehlgeschlagen (DEUSER0001, ${encodeURIComponent(password).replace(/%20/g, "+")}) / (${encodeURIComponent(password)})`;
  const e = new RequestEngine({ transport: async () => ({ status: 404, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ Code: 2, Content: echo, Type: "ERROR" })) }) });
  await assert.rejects(e.postJson("/find/find", {}, { username: "DEUSER0001", password }), (err: RegionalstatistikApiError) => {
    for (const text of [err.message, err.detail ?? "", String(err.body)]) {
      assert.ok(!text.includes("Geheim+2026x") && !text.includes("Geheim%202026x"), text);
    }
    return true;
  });
});
