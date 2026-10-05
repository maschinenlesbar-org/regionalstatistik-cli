// Conformance test P2 (fix plan 2026-10-06): a library user who logs a client or an error —
// console.log, util.inspect, JSON.stringify, `.message`, `.url`, the `cause` chain — never
// sees a password from the base URL. Shared across the *-cli repos; only the adapter differs.
// (Keyed repos: the secret is the key/token/password the client sends, so the adapter says
// how to build a client holding it and how a server or transport would echo it.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { RegionalstatistikClient as Client } from "../src/client/client.js";
/** One call that makes a single request and needs no arguments. */
const call = (client: Client): Promise<unknown> => client.catalogue.tables();
/** A 2xx body the call accepts. */
const okBody = { Ident: {}, Status: { Code: 0, Content: "erfolgreich", Type: "Information" }, Parameter: {}, Copyright: "", List: [] };
const PW = "s3cret-Pw";
/** A client holding the secret, on the given transport. */
const makeClient = (transport: (req: HttpRequest) => Promise<HttpResponse>, extra: Record<string, unknown> = {}): Client =>
  new Client({ username: "alice-user", password: PW, transport, ...extra });
/** What a server or transport that echoes the request would repeat (it must contain PW). */
const echo = (req: HttpRequest): string => `${req.url} ${JSON.stringify(req.headers)}`;
/** Constructor options that are rejected and hold the secret. */
const rejectedOptions: Array<Record<string, unknown>> = [
  { baseUrl: `https://alice:${PW}@mirror.example` },
  { baseUrl: `https://alice:${PW}@mirror.example/?x=1` },
  { baseUrl: `https://alice:pa#${PW}@mirror.example` },
  { baseUrl: `ftp://alice:${PW}@h` },
  { username: "alice-user", password: `${PW} ` },
  { token: `${PW}\n` },
  { token: `${PW}€` },
  { username: `${PW}` },
];
// --------------------------------------------------------------------------------------

function everything(value: unknown): string {
  let text = inspect(value, { depth: 10, showHidden: true });
  try {
    text += JSON.stringify(value);
  } catch {
    // circular: inspect covers it
  }
  if (value instanceof Error) {
    text += value.message + String((value as { url?: unknown }).url ?? "");
    for (let c: unknown = value.cause; c !== undefined && c !== null; c = (c as { cause?: unknown }).cause) {
      text += inspect(c, { depth: 10 }) + (c instanceof Error ? c.message : String(c));
    }
  }
  return text;
}

async function failure(transport: (req: HttpRequest) => Promise<HttpResponse>): Promise<unknown> {
  const client = makeClient(transport, { maxRetries: 0 });
  try {
    await call(client);
  } catch (err) {
    return err;
  }
  return assert.fail("the call should have failed");
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});

test("P2: logging a client never shows the password", () => {
  const client = makeClient(async () => json(200, okBody));
  assert.ok(!everything(client).includes(PW), everything(client));
});

test("P2: no error a call can raise carries the password", async () => {
  const cases: Array<[string, (req: HttpRequest) => Promise<HttpResponse>]> = [
    ["HTTP 404", async () => json(404, { message: "not here" })],
    ["HTTP 500", async () => json(500, { message: "boom" })],
    ["HTTP 503 with an echoing body", async (req) => json(503, { message: `bad ${echo(req)}` })],
    ["HTTP 500 with an echoing text body", async (req) => ({ status: 500, headers: { "content-type": "text/plain" }, body: Buffer.from(`bad ${echo(req)}`) })],
    ["HTTP 200 error status echoing the request", async (req) => json(200, { Status: { Code: -1, Content: `bad ${echo(req)}`, Type: "Fehler" } })],
    ["redirect", async () => json(301, "", { location: `https://alice:${PW}@elsewhere.example/x` })],
    ["parse error", async () => json(200, "not json")],
    ["parse error echoing the request", async (req) => json(200, `{"x": ${echo(req)}`)],
    ["empty body", async () => json(200, "")],
    ["transport throws with the request in its message", async (req) => { throw new TypeError(`Failed to fetch ${echo(req)}`); }],
    ["transport throws a string with the request", async (req) => { throw `cannot reach ${echo(req)}`; }],
    ["transport throws a nested cause with the request", async (req) => { throw new Error("fetch failed", { cause: new Error(`connect to ${echo(req)}`) }); }],
  ];
  for (const [label, transport] of cases) {
    const err = await failure(transport);
    assert.ok(!everything(err).includes(PW), `${label}: ${everything(err)}`);
  }
});

test("P2: rejected options are not echoed by the constructor", () => {
  for (const options of rejectedOptions) {
    try {
      new Client(options);
      assert.fail(`accepted ${JSON.stringify(options)}`);
    } catch (err) {
      assert.ok(!everything(err).includes(PW), `${JSON.stringify(options)}: ${everything(err)}`);
    }
  }
});
