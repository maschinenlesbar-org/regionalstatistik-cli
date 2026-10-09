// Conformance test P18 (fix plan 2026-10-06): a GENESIS login check confirms a login only
// when the server does. GENESIS answers `helloworld/logincheck` with HTTP 200 whether or not
// the credentials are right; wrong ones come back as a string `Status` with an error text,
// and a wrong token is echoed as `Username` (live, 2026-10-05). Those, the flat and
// enveloped error statuses and the 401/404 auth answers must all be an auth error — exit 1
// with the credentials hint, never exit 0 — and an answer that confirms nothing must not
// pass either. Shared by the GENESIS repos (destatis-genesis-cli, regionalstatistik-cli);
// only the adapter block differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse, Transport } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { RegionalstatistikClient as Client } from "../src/client/client.js";
import { RegionalstatistikApiError as ApiError, RegionalstatistikParseError as ParseError } from "../src/client/errors.js";
/** Obviously fake credentials. */
const TOKEN = "0123456789abcdef0123456789abcdef";
const USER = "testuser01";
const PASSWORD = "s3cret-Test-Pw";
/** The environment that selects each login mode in the CLI. */
const ENV = {
  token: { REGIONALSTATISTIK_API_TOKEN: TOKEN },
  pair: { REGIONALSTATISTIK_USERNAME: USER, REGIONALSTATISTIK_PASSWORD: PASSWORD },
};
/** A library client in each login mode. */
const clientFor = (mode: "token" | "pair", transport: Transport): Client =>
  new Client(mode === "token" ? { token: TOKEN, transport, maxRetries: 0 } : { username: USER, password: PASSWORD, transport, maxRetries: 0 });
/** The library's login check, and the CLI's. */
const libLogincheck = (client: Client): Promise<unknown> => client.logincheck();
const LOGINCHECK_ARGV = ["logincheck"];
/** The line the CLI adds to an auth error. */
const CREDENTIALS_HINT = /^\S+ INFO  \[regstat\.api\] check your credentials/m;
/** The members this repo's CliIO has besides out/err. */
const IO_EXTRAS = { writeFile: () => {}, fileExists: () => false, outBinary: () => {} };
/** The server's texts (live, www.regionalstatistik.de 2026-10-05; the success text is the guest answer's). */
const FAIL_TEXT = "Ein Fehler ist aufgetreten. (Bitte prüfen und korrigieren Sie Ihren Nutzernamen bzw.\n das Passwort.)";
const OK_TEXT =
  "Sie wurden erfolgreich an- und abgemeldet! Bei mehr als 10 parallelen Requests wurden länger als 15 Minuten laufende Requests beendet.";
const NOT_AUTHORIZED_TEXT =
  "Sie sind nicht berechtigt diesen Service aufzurufen oder der Header Ihres Requests enthält nicht alle notwendigen Angaben, sodass Ihre Zugangsdaten nicht erkannt werden.";
// --------------------------------------------------------------------------------------

type Mode = "token" | "pair";
interface Case {
  label: string;
  modes: Mode[];
  status: number;
  body: unknown;
}

const BOTH: Mode[] = ["token", "pair"];

/** Answers that mean "wrong credentials". */
const REJECTED: Case[] = [
  { label: "live: 200, string Status error text, the token echoed as Username", modes: ["token"], status: 200, body: { Status: FAIL_TEXT, Username: TOKEN } },
  { label: "live: 200, string Status error text, the user name echoed", modes: ["pair"], status: 200, body: { Status: FAIL_TEXT, Username: USER } },
  { label: "200, string Status error text, no Username", modes: BOTH, status: 200, body: { Status: FAIL_TEXT } },
  { label: "200, flat Code 2 ERROR", modes: BOTH, status: 200, body: { Code: 2, Content: FAIL_TEXT, Type: "ERROR" } },
  { label: "200, enveloped Code 15 ERROR", modes: BOTH, status: 200, body: { Status: { Code: 15, Content: NOT_AUTHORIZED_TEXT, Type: "ERROR" } } },
  { label: "200, enveloped Code 2 with a Fehler type", modes: BOTH, status: 200, body: { Status: { Code: "2", Content: FAIL_TEXT, Type: "Fehler" }, Username: USER } },
  { label: "200, an unrecognised Status with the token echoed as Username", modes: ["token"], status: 200, body: { Status: "Wartungsarbeiten", Username: TOKEN } },
  { label: "live (data endpoints): 404, flat Code 2", modes: BOTH, status: 404, body: { Code: 2, Content: FAIL_TEXT, Type: "ERROR" } },
  { label: "401, flat Code 15", modes: BOTH, status: 401, body: { Code: 15, Content: NOT_AUTHORIZED_TEXT, Type: "ERROR" } },
];

/** Answers that confirm the login. */
const ACCEPTED: Case[] = [
  { label: "200, string Status success text", modes: BOTH, status: 200, body: { Status: OK_TEXT, Username: "TESTUSER12" } },
  { label: "200, English success text", modes: BOTH, status: 200, body: { Status: "You have been logged in and out successfully!", Username: "TESTUSER12" } },
  { label: "200, enveloped Code 0", modes: BOTH, status: 200, body: { Status: { Code: 0, Content: "erfolgreich", Type: "Information" }, Username: "TESTUSER12" } },
];

/** Answers that confirm nothing: neither accepted nor an auth error. */
const MALFORMED: Case[] = [
  { label: "an unrecognised Status, another Username", modes: BOTH, status: 200, body: { Status: "Wartungsarbeiten", Username: "someone" } },
  { label: "a success text without Username", modes: BOTH, status: 200, body: { Status: OK_TEXT } },
  { label: "null", modes: BOTH, status: 200, body: null },
  { label: "{}", modes: BOTH, status: 200, body: {} },
  { label: "[]", modes: BOTH, status: 200, body: [] },
  { label: "a Status without Code", modes: BOTH, status: 200, body: { Status: {}, Username: "TESTUSER12" } },
];

const answer = (c: Case): Transport => async (): Promise<HttpResponse> => ({
  status: c.status,
  headers: { "content-type": "application/json;charset=UTF-8" },
  body: Buffer.from(JSON.stringify(c.body)),
});

async function cliRun(mode: Mode, c: Case) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), ...IO_EXTRAS },
    env: { ...ENV[mode] },
    createClient: (opts) => new Client({ ...opts, transport: answer(c), maxRetries: 0 }),
  };
  const code = await run(LOGINCHECK_ARGV, deps);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function assertNoCredential(text: string, context: string): void {
  for (const secret of [TOKEN, PASSWORD]) assert.ok(!text.includes(secret), `${context}: a credential was printed:\n${text}`);
}

test("P18: wrong credentials are an auth error in the library", async () => {
  for (const c of REJECTED) {
    for (const mode of c.modes) {
      await assert.rejects(libLogincheck(clientFor(mode, answer(c))), (e: unknown) => {
        assert.ok(e instanceof ApiError, `${c.label} (${mode}): ${String(e)}`);
        assert.equal(e.isAuthError, true, `${c.label} (${mode}): isAuthError`);
        assert.equal(e.isNotFound, false, `${c.label} (${mode}): isNotFound`);
        assertNoCredential(`${e.message} ${e.body} ${e.detail ?? ""}`, `${c.label} (${mode})`);
        return true;
      });
    }
  }
});

test("P18: wrong credentials exit 1 with the credentials hint, printing nothing on stdout", async () => {
  for (const c of REJECTED) {
    for (const mode of c.modes) {
      const r = await cliRun(mode, c);
      assert.equal(r.code, 1, `${c.label} (${mode}): exit ${r.code}\n${r.err}`);
      assert.match(r.err, CREDENTIALS_HINT, `${c.label} (${mode})`);
      assert.equal(r.out, "", `${c.label} (${mode}): stdout`);
      assertNoCredential(r.out + r.err, `${c.label} (${mode})`);
    }
  }
});

test("P18: a confirmed login resolves and exits 0", async () => {
  for (const c of ACCEPTED) {
    for (const mode of c.modes) {
      await assert.doesNotReject(libLogincheck(clientFor(mode, answer(c))), `${c.label} (${mode})`);
      const r = await cliRun(mode, c);
      assert.equal(r.code, 0, `${c.label} (${mode}): ${r.err}`);
      assert.doesNotMatch(r.err, CREDENTIALS_HINT);
    }
  }
});

test("P18: an answer that confirms nothing is a parse error (exit 1, no credentials hint)", async () => {
  for (const c of MALFORMED) {
    for (const mode of c.modes) {
      await assert.rejects(libLogincheck(clientFor(mode, answer(c))), ParseError, `${c.label} (${mode})`);
      const r = await cliRun(mode, c);
      assert.equal(r.code, 1, `${c.label} (${mode}): ${r.err}`);
      assert.doesNotMatch(r.err, CREDENTIALS_HINT, `${c.label} (${mode})`);
    }
  }
});
