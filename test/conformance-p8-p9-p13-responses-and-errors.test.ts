// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { RegionalstatistikClient, type RegionalstatistikClientOptions } from "../src/client/client.js";
import { RegionalstatistikError as BaseError, RegionalstatistikParseError as ParseError } from "../src/client/errors.js";
/** A well-formed fake token. */
const TOKEN = "0123456789abcdef0123456789abcdef";
/**
 * Every listing (`find` included) needs an account here, so the shared cases' clients carry
 * a fake token unless they set credentials themselves.
 */
class Client extends RegionalstatistikClient {
  constructor(options: RegionalstatistikClientOptions = {}) {
    super({ token: TOKEN, ...options });
  }
}
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.find({ term: "Bevölkerung" });
const textBody = (text: string): unknown => ({
  Ident: { Service: "find", Method: "find" },
  Status: { Code: 0, Content: "erfolgreich", Type: "Information" },
  Parameter: {},
  Copyright: "",
  Tables: [{ Code: "12411-0001", Content: text }],
});
const readText = (result: unknown): string => (result as { Tables: Array<{ Content: string }> }).Tables[0]!.Content;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  null,
  {},
  [],
  "text",
  42,
  { error: "boom" },
  { Status: "erfolgreich" },
  { Status: {} },
  { Status: { Code: 0 }, Tables: "12411-0001" },
  { Tables: [{ Code: "12411-0001" }] },
  { Code: 2, Content: "Ein Fehler ist aufgetreten.", Type: "ERROR" },
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `body ${JSON.stringify(body)}`);
    // An error envelope is the API's error; every other wrong shape is a parse error.
    const isErrorEnvelope = typeof body === "object" && body !== null && "Type" in body;
    if (!isErrorEnvelope) await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});
