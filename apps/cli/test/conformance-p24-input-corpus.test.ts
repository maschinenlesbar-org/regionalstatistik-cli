// Conformance test P24 (trend analysis 2026-10-21): an input is canonicalised or refused, never
// sent raw. One corpus of tricky values goes through every text filter and every id the repo
// declares, on the CLI and in the library. Either both refuse it before any request (exit 2,
// the validation error), or both send the same request with the value in canonical form: a
// text without surrounding whitespace, in composed Unicode, never blank; an id as the adapter
// canonicalises it, never empty, a dot segment or with a "/". Each value here was once sent raw
// by some *-cli and matched nothing, or the wrong thing, with exit 0. Shared across the *-cli
// repos; only the adapter differs.

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
/** A test token, injected on both sides (`find` needs an account; nothing reads the user's). */
const TOKEN = "0123456789abcdef0123456789abcdef";
import { RegionalstatistikClient, type RegionalstatistikClientOptions } from "@maschinenlesbar.org/regionalstatistik-client/internal/client";
import * as fx from "@maschinenlesbar.org/regionalstatistik-client/test/fixtures";
/** The library side logs in with that token, as the CLI does from the variable. */
class Client extends RegionalstatistikClient {
  constructor(options: RegionalstatistikClientOptions) {
    super({ token: TOKEN, ...options });
  }
}
interface Input {
  name: string;
  /** CLI argv that sends `value`. */
  argv: (value: string) => string[];
  /** The same in the library. */
  lib: (client: Client, value: string) => Promise<unknown>;
  /** The value as it went out, read from the request URL (null when it wasn't sent). */
  sent: (url: URL) => string | null;
}
/**
 * The form bodies the CLI and the library sent, in order. GENESIS takes every parameter in a
 * POST form body, not the URL (the URL is the same for every `find`), so `respond` records the
 * `term` of each request and `sent` reads the two of one input: the CLI's and the library's,
 * which must agree (the body compares only the URLs).
 */
const terms: Array<string | null> = [];
function sentTerm(): string | null {
  const [cli, lib, ...more] = terms.splice(0);
  return more.length === 0 && cli === lib ? (cli ?? null) : `CLI ${JSON.stringify(cli)}, library ${JSON.stringify(lib)}`;
}
/**
 * Every text filter (sent as a form parameter): the `find` term, GENESIS's one free-text input.
 * The catalogue's `selection`, the object codes, the years, the regional variable and keys and
 * the classifying keys are codes, sent as given (NFC only), so they are not here.
 */
const textInputs: Input[] = [
  { name: "find", argv: (v) => ["find", v], lib: (c, v) => c.find({ term: v }), sent: () => sentTerm() },
];
/**
 * Every id that goes into a request path: none. Every GENESIS endpoint has a fixed path; the
 * object code travels in the form body (`name`), so no value can re-target a request.
 */
const idInputs: Input[] = [];
/** The id as the repo sends it (unused: no id goes into a path). */
const canonicalId = (value: string): string => value.trim();
/** A valid answer to any of these requests (a detail echoes the id it was asked for). */
const respond = (req: HttpRequest): HttpResponse => {
  terms.push(bodyOf(req).get("term"));
  return jsonResponse(fx.findResult);
};
// --------------------------------------------------------------------------------------

const TEXT_CORPUS = [
  "Müller", "Müller", "  Müller  ", " Müller ", "Müller\n", "\tMüller", "a  b", "Å",
  "ﬁ", "x".repeat(5000), "", " ", " ", "\n\t", "　",
];
const ID_CORPUS = ["a1", " a1 ", "a1\n", " a1", ".", "..", " .. ", "a1/../a2", "a1/", "/a1", "", "  ", "%2e%2e", "a b"];

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
  assert.equal(o.lib.ok, true, `${label}: the library rejected: ${String(o.lib.error)}`);
  assert.deepEqual(o.lib.requests.map((r) => r.url), o.cli.requests.map((r) => r.url), `${label}: different requests`);
  assert.equal(o.cli.requests.length, 1, label);
  return new URL(o.cli.requests[0]!.url);
}

test("P24: a text filter is sent trimmed and in composed Unicode, or refused; never blank", async () => {
  for (const input of textInputs) {
    for (const value of TEXT_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      if (value.trim() === "") {
        assert.equal(url, undefined, `${label}: a blank value was sent (it reads as "no filter")`);
        continue;
      }
      if (url === undefined) continue;
      const sent = input.sent(url);
      assert.ok(sent !== null && sent !== "", `${label}: not sent`);
      const canonical = [value.trim().normalize("NFC"), value.trim().normalize("NFKC")];
      assert.ok(canonical.includes(sent), `${label}: sent ${JSON.stringify(sent)}`);
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
