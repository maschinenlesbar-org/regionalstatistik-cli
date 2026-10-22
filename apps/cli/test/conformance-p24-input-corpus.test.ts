// Conformance test P24 (trend analysis 2026-10-21; fix plan 2026-10-21, D8 and D10): an input
// is canonicalised or refused, never sent raw. One corpus of tricky values goes through every
// text filter, every token (id, code, enum, sort key) and every list the repo declares, on the
// CLI and in the library. Either both refuse it before any request (exit 2, the validation
// error), or both send the same request with the value in canonical form: a text without
// surrounding whitespace, in composed Unicode, never blank; a token as the adapter canonicalises
// it, never empty, a dot segment or with a "/"; a list item by item. A value that holds only
// invisible characters or combining marks is blank. A refusal shows an invisible or control
// character escaped (`\u200b`), never raw. Each value here was once sent raw by some *-cli and
// matched nothing, or the wrong thing, with exit 0. Shared across the *-cli repos; only the
// adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/regionalstatistik-client/internal/http";

// ---- adapter (per repo) -------------------------------------------------------------
/**
 * `parity(argv, call, responder)`: argv through run() and `call` through the library, each on a
 * recording mock transport; resolves to `{ cli: { code, out, err, requests }, lib: { ok, value?,
 * error?: { name, message }, requests } }`. This repo's helper takes an object, and its `error` is
 * the Error itself, which has `name` and `message`; the CLI side gets the test token from
 * REGIONALSTATISTIK_API_TOKEN (a `--token` flag would add a WARN record to stderr).
 */
import { bodyOf, jsonResponse, parity as parityOf, type ParityResult } from "./helpers.js";
import type { Transport } from "@maschinenlesbar.org/regionalstatistik-client/internal/http";
const parity = (
  argv: string[],
  lib: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse,
): Promise<ParityResult> => parityOf({ argv, lib, responder, env: { REGIONALSTATISTIK_API_TOKEN: TOKEN } });
/** The exit code of a usage error in this repo (commander's default is 1; most repos use 2). */
const USAGE_EXIT = 2;
/** A test token, injected on both sides (every input needs an account; nothing reads the user's). */
const TOKEN = "0123456789abcdef0123456789abcdef";
import { RegionalstatistikClient, type RegionalstatistikClientOptions } from "@maschinenlesbar.org/regionalstatistik-client/internal/client";
import * as fx from "@maschinenlesbar.org/regionalstatistik-client/test/fixtures";
/** The library side logs in with that token, as the CLI does from the variable. */
class Client extends RegionalstatistikClient {
  constructor(options: RegionalstatistikClientOptions) {
    super({ token: TOKEN, ...options });
  }
}
interface Input<T = string | null> {
  name: string;
  /** CLI argv that sends `value`. */
  argv: (value: string) => string[];
  /** The same in the library. */
  lib: (client: Client, value: string) => Promise<unknown>;
  /** The value as it went out, read from the request URL (null when it wasn't sent). */
  sent: (url: URL) => T;
}
/**
 * The form bodies the CLI and the library sent, in order. GENESIS takes every parameter in a
 * POST form body, not the URL (the URL is the same for every call of an endpoint), so `respond`
 * records each body and `sent` reads one parameter from the two of one input: the CLI's and the
 * library's, which must agree (the body compares only the URLs).
 */
const bodies: URLSearchParams[] = [];
function sentParam(name: string): string | null {
  const [cli, lib, ...more] = bodies.splice(0).map((body) => body.get(name));
  return more.length === 0 && cli === lib ? (cli ?? null) : `CLI ${JSON.stringify(cli)}, library ${JSON.stringify(lib)}`;
}
/**
 * Every free-text and code input. The `find` term is free text; the rest are codes GENESIS
 * compares exactly (sent trimmed and in NFC, refused when blank, invisible or with a control or
 * format character). They are listed here, not as ids: every GENESIS endpoint has a fixed path
 * and every value travels in the form body, so a "/" or ".." in a code can't re-target a
 * request (the id test's rule), and the canonical form of a code is the text test's.
 */
const textInputs: Input[] = [
  { name: "find", argv: (v) => ["find", v], lib: (c, v) => c.find({ term: v }), sent: () => sentParam("term") },
  { name: "metadata table <name>", argv: (v) => ["metadata", "table", v], lib: (c, v) => c.metadata.table(v), sent: () => sentParam("name") },
  { name: "data table <name>", argv: (v) => ["data", "table", v], lib: (c, v) => c.data.table(v), sent: () => sentParam("name") },
  { name: "catalogue tables <selection>", argv: (v) => ["catalogue", "tables", v], lib: (c, v) => c.catalogue.tables({ selection: v }), sent: () => sentParam("selection") },
  { name: "catalogue tables --area", argv: (v) => ["catalogue", "tables", "--area", v], lib: (c, v) => c.catalogue.tables({ area: v }), sent: () => sentParam("area") },
  { name: "data table --start-year", argv: (v) => ["data", "table", "x", "--start-year", v], lib: (c, v) => c.data.table("x", { startyear: v }), sent: () => sentParam("startyear") },
  { name: "data table --stand", argv: (v) => ["data", "table", "x", "--stand", v], lib: (c, v) => c.data.table("x", { stand: v }), sent: () => sentParam("stand") },
  { name: "data table --region-var", argv: (v) => ["data", "table", "x", "--region-var", v], lib: (c, v) => c.data.table("x", { regionalvariable: v }), sent: () => sentParam("regionalvariable") },
  { name: "data table --region-key", argv: (v) => ["data", "table", "x", "--region-key", v], lib: (c, v) => c.data.table("x", { regionalkey: v }), sent: () => sentParam("regionalkey") },
  { name: "data table --class-key1", argv: (v) => ["data", "table", "x", "--class-key1", v], lib: (c, v) => c.data.table("x", { classifyingkey1: v }), sent: () => sentParam("classifyingkey1") },
];
/** Every token that goes into a request path: none (see above). */
const idInputs: Input[] = [];
/** Every comma-separated list option; `sent` gives the items as they went out. */
const listInputs: Array<Input<string[] | null>> = [
  { name: "data table --contents", argv: (v) => ["data", "table", "x", "--contents", v], lib: (c, v) => c.data.table("x", { contents: v }), sent: () => sentParam("contents")?.split(",") ?? null },
];
/** A code as the repo sends it (trimmed, NFC). */
const canonicalId = (value: string): string => value.trim().normalize("NFC");
/** A valid answer to any of these requests: a GENESIS envelope. */
const respond = (req: HttpRequest): HttpResponse => {
  bodies.push(bodyOf(req));
  return jsonResponse(fx.findResult);
};
// --------------------------------------------------------------------------------------

/** Values every input refuses: blank, only invisible characters or combining marks, a lone surrogate, a control or format character. */
const REFUSED = [
  "", " ", "\u00a0", "\n\t", "\u3000", "\u200b", "\u00ad", "\u200d", "\ufeff", "\u0301\u0308", " \u200b ",
  "a\u200bb", "M\u00fcl\u00adler", "\u202eabc", "a\u0000b", "a\u001bb", "a\u0085b", "\ud800", "a\udc00b", "x\ud83d",
];
const TEXT_CORPUS = [
  "Müller", "Mu\u0308ller", "  Müller  ", "\u00a0Müller\u00a0", "Müller\n", "\tMüller", "a  b", "A\u030a",
  "ﬁ", "x".repeat(5000), "\u3000x", "😀 smile", "a\u200db",
];
const ID_CORPUS = ["a1", " a1 ", "a1\n", " a1", ".", "..", " .. ", "a1/../a2", "a1/", "/a1", "%2e%2e", "a b", "e\u0301"];
const LIST_REFUSED = ["", ",", " , ", "a1,,a2", "a1,", ",a1", "a1,\u200b", "a1,a\u200bb", "\ud800,a1"];
const LIST_CORPUS = ["a1", "a1,a2", " a1 , a2 ", "e\u0301,a2", "a1,a1"];

type Outcome = Awaited<ReturnType<typeof parity>>;

/** Both sides refused before any request, or both sent the same requests. Returns the one sent URL, if any. */
function sameOutcome(o: Outcome, label: string): URL | undefined {
  if (o.cli.code === USAGE_EXIT) {
    assert.deepEqual(o.cli.requests, [], `${label}: the CLI refused but sent a request`);
    assert.equal(o.lib.ok, false, `${label}: the CLI refused, the library resolved`);
    assert.deepEqual(o.lib.requests, [], `${label}: the library sent a request`);
    assert.match(o.lib.error?.name ?? "", /ValidationError$/, `${label}: ${String(o.lib.error)}`);
    return undefined;
  }
  assert.equal(o.cli.code, 0, `${label}: CLI exit ${o.cli.code}: ${o.cli.err}`);
  assert.equal(o.lib.ok, true, `${label}: the library rejected: ${String(o.lib.error?.message)}`);
  assert.deepEqual(o.lib.requests.map((r) => r.url), o.cli.requests.map((r) => r.url), `${label}: different requests`);
  assert.equal(o.cli.requests.length, 1, label);
  return new URL(o.cli.requests[0]!.url);
}

/** A control, format or lone-surrogate character in `value`, or undefined. */
const INVISIBLE = /[\p{Cc}\p{Cf}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

/** A refusal of `value` shows its invisible character as an escape on both sides, never raw (D10). */
function refusedVisibly(o: Outcome, value: string, label: string): void {
  const blank = value.replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, "") === "";
  const ch = INVISIBLE.exec(value.trim())?.[0];
  if (ch === undefined || blank) return;
  const escape = `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  assert.ok(o.cli.err.toLowerCase().includes(escape), `${label}: the CLI's refusal doesn't show ${escape}: ${o.cli.err}`);
  assert.ok(!o.cli.err.includes(ch), `${label}: the CLI's refusal shows the character raw`);
  assert.ok((o.lib.error?.message ?? "").toLowerCase().includes(escape), `${label}: the library's refusal doesn't show ${escape}: ${o.lib.error?.message}`);
}

const short = (value: string): string => JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value);

test("P24: a text filter is sent trimmed and in composed Unicode, or refused; never blank", async () => {
  for (const input of textInputs) {
    for (const value of TEXT_CORPUS) {
      const label = `${input.name} ${short(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      if (url === undefined) continue;
      const sent = input.sent(url);
      assert.ok(sent !== null && sent !== "", `${label}: not sent`);
      const canonical = [value.trim().normalize("NFC"), value.trim().normalize("NFKC")];
      assert.ok(canonical.includes(sent), `${label}: sent ${JSON.stringify(sent)}`);
    }
  }
});

test("P24: every input refuses a blank, invisible, control or half character, before any request, showing it escaped", async () => {
  const inputs = [...textInputs, ...idInputs];
  for (const input of inputs) {
    for (const value of REFUSED) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const o = await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond);
      assert.equal(o.cli.code, USAGE_EXIT, `${label}: CLI exit ${o.cli.code}, sent ${o.cli.requests.map((r) => r.url).join(" ")}`);
      assert.equal(sameOutcome(o, label), undefined, label);
      refusedVisibly(o, value, label);
    }
  }
});

test("P24: an id is sent in its canonical form, or refused; never empty, a dot segment or with a slash", async () => {
  for (const input of idInputs) {
    for (const value of ID_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      const id = canonicalId(value);
      if (id === "" || id === "." || id === ".." || id.includes("/")) {
        assert.equal(url, undefined, `${label}: sent although it would re-target the request`);
        continue;
      }
      if (url === undefined) continue;
      assert.equal(input.sent(url), id, label);
    }
  }
});

test("P24: a list is canonicalised item by item; an empty or invisible item refuses the whole list", async () => {
  for (const input of listInputs) {
    for (const value of LIST_REFUSED) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const o = await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond);
      assert.equal(o.cli.code, USAGE_EXIT, `${label}: CLI exit ${o.cli.code}`);
      assert.equal(sameOutcome(o, label), undefined, label);
      refusedVisibly(o, value.split(",").find((item) => INVISIBLE.test(item)) ?? "", label);
    }
    for (const value of LIST_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      assert.ok(url !== undefined, `${label}: refused`);
      assert.deepEqual(input.sent(url), value.split(",").map(canonicalId), label);
    }
  }
});
