// Conformance test P1 (fix plan 2026-10-06): no credential from a base URL reaches the
// CLI's output, whatever the password contains and wherever the URL is typed. Shared across
// the *-cli repos; only the adapter block below differs per repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { RegionalstatistikClient as Client } from "../src/client/client.js";
/** The environment variable the CLI reads a base URL from, or undefined if it has none. */
const BASE_URL_ENV: string | undefined = undefined; // regstat reads only credential variables (keyed part below)
/** A command that needs no arguments and makes one request. */
const SIMPLE_COMMAND = ["hello"];
/** A command that takes one positional argument, for the "URL as argument" case. */
const ARG_COMMAND = ["find"];
/** An option that takes a value and validates it, for the "URL as option value" case. */
const VALUE_OPTION = "--timeout";
/** A successful answer to SIMPLE_COMMAND. */
const okBody = { "User-Agent": "regionalstatistik-cli" };
/** The members this repo's CliIO has besides out/err. */
const IO_EXTRAS = { writeFile: () => {}, fileExists: () => false, outBinary: () => {} };
/**
 * Keyed repos: the secret flags, their environment variables, a command that uses them and
 * one that ignores them. regstat has three (a token, or a username and password); a repo
 * with one key lists one.
 */
const KEY_FLAGS: string[] = ["--token", "--username", "--password"];
const KEY_ENVS: string[] = ["REGIONALSTATISTIK_API_TOKEN", "REGIONALSTATISTIK_USERNAME", "REGIONALSTATISTIK_PASSWORD"];
const KEYED_COMMAND = ["logincheck"];
const KEYLESS_COMMAND = ["hello"];
/** Keys a usage error must not echo: pasted with surrounding or invisible characters. */
const BAD_KEYS = [
  "s3cret-Test-Pw01 ",
  " s3cret-Test-Pw01",
  "s3cret-Test-Pw01\t",
  "TOKENFAKE0123456789€0123456789",
  "TOKENFAKE0123456789\n0123456789",
  "TOKENFAKE0123456789😀",
];
/** A well-formed key, for the "typed without its flag" case. */
const GOOD_KEY = "0123456789abcdefABCDEF0123456789";
/** A secret typed where a command or argument goes, which the CLI must not echo either. */
const STRAY_SECRETS = ["TOKEN-FAKE-zzzz-0001", "s3cret-Test-Pw01"];
/** Credential environments that let KEYED_COMMAND run, and its answer echoing the request headers. */
const KEYED_ENV_SETS: Array<Record<string, string>> = [
  { REGIONALSTATISTIK_API_TOKEN: GOOD_KEY },
  { REGIONALSTATISTIK_USERNAME: "an0ther-User", REGIONALSTATISTIK_PASSWORD: "an0ther-Secret" },
];
const echoingOkBody = (headers: Record<string, string>): unknown => ({
  Status: "Sie wurden erfolgreich an- und abgemeldet!",
  Username: headers["username"] ?? "",
  // Each header as a whole value: on stdout a bare secret is replaced only as a whole JSON
  // value, never inside other text (destatis-genesis 03-1, user decision 2026-10-09).
  Echo: headers,
});
// --------------------------------------------------------------------------------------

/** Passwords that defeated a pattern-based redaction in the 2026-10-05 sweep. */
const PASSWORDS = ["s3cret-pw", "pa#ss-pw", "pa?ss-pw", "pa/ss-pw", "pa ss-pw", "o'brien-pw", 'pa"ss-pw', "päss-pw", "p@ss-pw", "tab\tpw"];

/**
 * Base-URL shapes per password: valid, rejected (query, fragment, port, scheme, space),
 * schemeless. Only a value with a scheme is taken for a URL anywhere in argv (a bare
 * `a:b@c` may be a file name or a search text, fix plan 2026-10-09 L14); a schemeless one
 * is still a credential as the base URL's value.
 */
function urls(pw: string): string[] {
  return [
    `https://alice:${pw}@mirror.example`,
    `https://alice:${pw}@mirror.example/?x=1`,
    `https://alice:${pw}@mirror.example/#f`,
    `https://alice:${pw}@mirror.example:99999`,
    `ftp://alice:${pw}@mirror.example`,
    `https://alice:${pw}@mirror.example `,
    `alice:${pw}@mirror.example/api`,
  ];
}

function cli(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const transport = async (): Promise<HttpResponse> => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(okBody)),
  });
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), ...IO_EXTRAS },
    env,
    createClient: (opts) => new Client({ ...opts, transport }),
  };
  return { deps, text: () => [...out, ...err].join("\n") };
}

function assertNoSecret(text: string, pw: string, context: string): void {
  // The whole password, and its JSON-escaped form, must be absent.
  for (const form of [pw, JSON.stringify(pw).slice(1, -1)]) {
    assert.ok(!text.includes(form), `${context}: password ${JSON.stringify(pw)} printed:\n${text}`);
  }
}

for (const pw of PASSWORDS) {
  test(`P1: no output path prints the password ${JSON.stringify(pw)}`, async () => {
    for (const url of urls(pw)) {
      const asBaseUrl: string[][] = [
        ["--base-url", url, ...SIMPLE_COMMAND],
        [`--base-url=${url}`, ...SIMPLE_COMMAND],
      ];
      const schemeless = !/^[a-z][a-z0-9+.-]*:\/\//i.test(url);
      const argvs: string[][] = schemeless ? asBaseUrl : [
        ...asBaseUrl,
        [url, ...SIMPLE_COMMAND], // forgot --base-url: unknown command
        [...SIMPLE_COMMAND, url], // surplus argument
        [...ARG_COMMAND, url], // as a positional value
        [VALUE_OPTION, url, ...SIMPLE_COMMAND], // as an option's value
        [`--bogus=${url}`, ...SIMPLE_COMMAND], // unknown option with the URL in it
        [`--compact=${url}`, ...SIMPLE_COMMAND], // boolean flag given the URL
        ["help", url],
      ];
      for (const argv of argvs) {
        const c = cli();
        await run(argv, c.deps);
        assertNoSecret(c.text(), pw, `argv ${JSON.stringify(argv)}`);
      }
      if (BASE_URL_ENV !== undefined) {
        for (const argv of [["--help"], [...SIMPLE_COMMAND, "--help"], ["help", ...SIMPLE_COMMAND], SIMPLE_COMMAND, []]) {
          const c = cli({ [BASE_URL_ENV]: url });
          await run(argv, c.deps);
          assertNoSecret(c.text(), pw, `${BASE_URL_ENV}=${JSON.stringify(url)} argv ${JSON.stringify(argv)}`);
        }
      }
    }
  });
}

test("P1: output without credentials is unchanged", async () => {
  const c = cli();
  const code = await run(SIMPLE_COMMAND, c.deps);
  assert.equal(code, 0);
  assert.ok(c.text().length > 0 && !c.text().includes("***"), c.text());
});

// ---- keyed repos: the secrets themselves (flag, environment, typed in the wrong place) ----

/** The visible part of a key: what a reader could copy from the terminal. */
const visible = (key: string): string[] => key.split(/[^\x21-\x7e]+/).filter((part) => part.length >= 8);

test("P1 (keyed): a rejected key is never echoed, by flag or environment", async (t) => {
  if (KEY_FLAGS.length === 0) return t.skip("this CLI takes no key");
  for (const key of BAD_KEYS) {
    for (const flag of KEY_FLAGS) {
      const argvs: string[][] = [
        [flag, key, ...KEYED_COMMAND],
        [`${flag}=${key}`, ...KEYED_COMMAND],
        [flag, key, ...KEYLESS_COMMAND],
      ];
      for (const argv of argvs) {
        const c = cli();
        await run(argv, c.deps);
        for (const part of visible(key)) assert.ok(!c.text().includes(part), `argv ${JSON.stringify(argv)}:\n${c.text()}`);
      }
    }
    for (const name of KEY_ENVS) {
      for (const argv of [KEYED_COMMAND, KEYLESS_COMMAND, ["--help"], ["help", ...KEYED_COMMAND]]) {
        const c = cli({ [name]: key });
        await run(argv, c.deps);
        for (const part of visible(key)) assert.ok(!c.text().includes(part), `${name} argv ${JSON.stringify(argv)}:\n${c.text()}`);
      }
    }
  }
});

test("P1 (keyed): a key typed without its flag is not echoed in full", async (t) => {
  if (KEY_FLAGS.length === 0) return t.skip("this CLI takes no key");
  for (const secret of [GOOD_KEY, ...STRAY_SECRETS]) {
    const argvs = [
      [secret, ...KEYED_COMMAND],
      [...KEYED_COMMAND, secret],
      [`--tokn=${secret}`, ...KEYED_COMMAND],
      // Only a key-shaped value is recognised after an unrelated option.
      ...(secret === GOOD_KEY ? [[VALUE_OPTION, secret, ...KEYED_COMMAND]] : []),
    ];
    for (const argv of argvs) {
      const c = cli();
      await run(argv, c.deps);
      assert.ok(!c.text().includes(secret), `argv ${JSON.stringify(argv)}:\n${c.text()}`);
    }
  }
});

test("P1 (keyed): a credential the server echoes back is not printed", async (t) => {
  if (KEYED_ENV_SETS.length === 0) return t.skip("this CLI takes no key");
  // A keyed command prints what the server sent, and a server (or a proxy) may echo the
  // credential back. The answer here repeats every request header it was given.
  for (const env of KEYED_ENV_SETS) {
    const out: string[] = [];
    const deps: CliDeps = {
      io: { out: (s) => out.push(s), err: (s) => out.push(s), ...IO_EXTRAS },
      env,
      createClient: (opts) =>
        new Client({
          ...opts,
          transport: async (req) => ({
            status: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify(echoingOkBody(req.headers ?? {}))),
          }),
        }),
    };
    await run(KEYED_COMMAND, deps);
    const text = out.join("\n");
    for (const secret of Object.values(env)) assert.ok(!text.includes(secret), `${JSON.stringify(env)}:\n${text}`);
  }
});
