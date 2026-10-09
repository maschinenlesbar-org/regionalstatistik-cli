// `regstat config` and the credentials file: the GENESIS login kept apart from argv
// and the environment, the same mechanism as openka-cli's `ka config` and
// dip-bundestag-cli's `dip config`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { run } from "../src/cli/run.js";
import { RegionalstatistikClient } from "../src/client/client.js";
import { RegionalstatistikError } from "../src/client/errors.js";
import type { CliDeps } from "../src/cli/io.js";
import { readSecretFrom } from "../src/cli/io.js";
import { CredentialStore, credentialValueProblem, maskCredential, resolveCredentialsPath } from "../src/cli/credentials.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, untimed } from "./helpers.js";
import * as fx from "./fixtures.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const USER = "max.mustermann@example.org";
const PASS = "Sommer Regen 2026!";

/** A CLI whose credentials file lives in a temporary directory, and whose secret prompt answers `secret`. */
function makeCli(
  options: {
    env?: Record<string, string | undefined>;
    secret?: string;
    credentials?: boolean;
    responder?: (req: HttpRequest) => HttpResponse;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "regstat-config-"));
  const store = new CredentialStore(join(dir, "regionalstatistik", "credentials"));
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(options.responder ?? (() => jsonResponse(fx.tablesList)));
  let secret = options.secret;
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => undefined,
      fileExists: () => false,
      outBinary: () => undefined,
      readSecret: async () => {
        if (secret === undefined) throw new Error("no secret prepared");
        return secret;
      },
    },
    createClient: (opts) => new RegionalstatistikClient({ ...opts, transport: mt.transport }),
    env: options.env ?? {},
    ...(options.credentials === false ? {} : { credentials: () => store }),
  };
  return {
    deps,
    out,
    err,
    mt,
    store,
    dir,
    answer: (value: string) => {
      secret = value;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The credential headers of the last request. */
function sent(cli: ReturnType<typeof makeCli>): { username?: string; password?: string } {
  const headers = cli.mt.last().headers ?? {};
  return {
    ...(headers["username"] !== undefined ? { username: headers["username"] } : {}),
    ...(headers["password"] !== undefined ? { password: headers["password"] } : {}),
  };
}

const MASKED: Record<string, [string, string]> = {
  token: [TOKEN, "0123…cdef"],
  username: [USER, "max.….org"],
  password: [PASS, "****"],
};

for (const [name, [value, mask]] of Object.entries(MASKED)) {
  test(`config set/get/list/unset ${name}: stored from the prompt, mode 0600 in a 0700 directory, shown masked`, async () => {
    const cli = makeCli({ secret: `${value}\n` });
    try {
      assert.equal(await run(["config", "set", name], cli.deps), 0);
      assert.equal(cli.store.get(name), value);
      assert.equal(statSync(cli.store.path).mode & 0o777, 0o600);
      assert.equal(statSync(join(cli.dir, "regionalstatistik")).mode & 0o777, 0o700);
      assert.ok(untimed(cli.err.join("\n")).includes(`INFO  [regstat.config] Stored ${name} (${mask}) in `), cli.err.join("\n"));
      assert.ok(!(cli.err.join("\n") + cli.out.join("\n")).includes(value));

      cli.out.length = 0;
      assert.equal(await run(["config", "get", name], cli.deps), 0);
      assert.deepEqual(cli.out, [mask]);
      cli.out.length = 0;
      assert.equal(await run(["config", "get", name, "--reveal"], cli.deps), 0);
      assert.deepEqual(cli.out, [value]);
      cli.out.length = 0;
      assert.equal(await run(["config", "list"], cli.deps), 0);
      assert.deepEqual(cli.out, [`${name}  ${mask}`]);
      assert.match(untimed(cli.err.join("\n")), /^INFO  \[regstat\.config\] Credentials file: .*regionalstatistik\/credentials/m);

      assert.equal(await run(["config", "unset", name], cli.deps), 0);
      assert.equal(cli.store.get(name), undefined);
      assert.equal(await run(["config", "unset", name], cli.deps), 1);
      assert.equal(await run(["config", "get", name], cli.deps), 1);
    } finally {
      cli.cleanup();
    }
  });
}

test("config list shows every stored credential, sorted and masked", async () => {
  const cli = makeCli();
  try {
    cli.store.set("username", USER);
    cli.store.set("password", PASS);
    cli.store.set("token", TOKEN);
    assert.equal(await run(["config", "list"], cli.deps), 0);
    assert.deepEqual(cli.out, ["password  ****", "token  0123…cdef", "username  max.….org"]);
  } finally {
    cli.cleanup();
  }
});

test("config set never takes the value from the command line, and never repeats it", async () => {
  for (const [name, value] of [["token", TOKEN], ["password", "Hunter2-geheim"], ["username", "someone"]] as const) {
    const cli = makeCli({ secret: value });
    try {
      assert.equal(await run(["config", "set", name, value], cli.deps), 2, name);
      assert.match(cli.err.join("\n"), /takes the name only/);
      assert.ok(!cli.err.join("\n").includes(value), name);
      assert.equal(cli.store.get(name), undefined);
    } finally {
      cli.cleanup();
    }
  }
  const cli = makeCli({ secret: TOKEN });
  try {
    assert.equal(await run(["config", "set", "api-key"], cli.deps), 2, "an unknown name");
    assert.equal(cli.store.names().length, 0);
  } finally {
    cli.cleanup();
  }
});

test("config set refuses a blank value, a control character or surrounding spaces, and stores nothing", async () => {
  for (const secret of ["", "   ", "\n", "pass\u0000word", "two\nlines", " padded", "padded ", "Zürich☃"]) {
    const cli = makeCli({ secret });
    try {
      assert.equal(await run(["config", "set", "password"], cli.deps), 2, JSON.stringify(secret));
      assert.match(cli.err.join("\n"), /Nothing was stored/);
      assert.equal(cli.store.get("password"), undefined);
    } finally {
      cli.cleanup();
    }
  }
});

test("config set keeps what the library accepts for a password: spaces and a tab inside, Latin-1, a leading --", async () => {
  for (const secret of [PASS, "a\tb c", "Grüße-ß", "--startet-mit-strichen", "!#$%&'()*+,;=?@[]"]) {
    const cli = makeCli({ secret: `${secret}\r\n` });
    try {
      assert.equal(await run(["config", "set", "password"], cli.deps), 0, JSON.stringify(secret));
      assert.equal(cli.store.get("password"), secret);
    } finally {
      cli.cleanup();
    }
  }
});

test("config set without a way to read a secret refuses", async () => {
  const cli = makeCli();
  try {
    delete (cli.deps.io as { readSecret?: unknown }).readSecret;
    assert.equal(await run(["config", "set", "token"], cli.deps), 2);
    assert.match(cli.err.join("\n"), /No way to read a secret here/);
  } finally {
    cli.cleanup();
  }
});

test("a stored token is sent when neither flags nor env vars give any credential", async () => {
  const cli = makeCli();
  try {
    cli.store.set("token", TOKEN);
    assert.equal(await run(["catalogue", "tables", "12411*"], cli.deps), 0);
    assert.deepEqual(sent(cli), { username: TOKEN });
  } finally {
    cli.cleanup();
  }
});

test("a stored username and password are sent as the pair; a stored token wins over them", async () => {
  const cli = makeCli();
  try {
    cli.store.set("username", USER);
    cli.store.set("password", PASS);
    assert.equal(await run(["catalogue", "tables", "12411*"], cli.deps), 0);
    assert.deepEqual(sent(cli), { username: USER, password: PASS });
    cli.store.set("token", TOKEN);
    assert.equal(await run(["catalogue", "tables", "12411*"], cli.deps), 0);
    assert.deepEqual(sent(cli), { username: TOKEN });
  } finally {
    cli.cleanup();
  }
});

test("flags and env vars come first: the file is not consulted, and nothing is taken from it", async () => {
  const cli = makeCli();
  try {
    cli.store.set("token", TOKEN);
    cli.store.set("username", USER);
    cli.store.set("password", PASS);
    const envPair = { ...cli.deps, env: { REGIONALSTATISTIK_USERNAME: "envuser", REGIONALSTATISTIK_PASSWORD: "envpass" } };
    assert.equal(await run(["catalogue", "tables", "12411*"], envPair), 0);
    assert.deepEqual(sent(cli), { username: "envuser", password: "envpass" });
    const envToken = { ...cli.deps, env: { REGIONALSTATISTIK_API_TOKEN: "ffffffffffffffffffffffffffffffff" } };
    assert.equal(await run(["catalogue", "tables", "12411*"], envToken), 0);
    assert.deepEqual(sent(cli), { username: "ffffffffffffffffffffffffffffffff" });
    assert.equal(await run(["--username", "flaguser", "--password", "flagpass", "catalogue", "tables", "12411*"], cli.deps), 0);
    assert.deepEqual(sent(cli), { username: "flaguser", password: "flagpass" });
  } finally {
    cli.cleanup();
  }
});

test("a login is never pieced together from two places", async () => {
  const cli = makeCli({ env: { REGIONALSTATISTIK_USERNAME: "envuser" } });
  try {
    cli.store.set("password", PASS);
    // The env var gives a username, so the file's password is not used: the pair error.
    assert.equal(await run(["catalogue", "tables", "12411*"], cli.deps), 2);
    assert.match(cli.err.join("\n"), /Provide BOTH --username and --password/);
    assert.equal(cli.mt.calls.length, 0);
    // A --password flag alone does not pick the username out of the file either.
    const bare = { ...cli.deps, env: {} };
    cli.store.unset("password");
    cli.store.set("username", USER);
    cli.err.length = 0;
    assert.equal(await run(["--password", "flagpass", "catalogue", "tables", "12411*"], bare), 2);
    assert.match(cli.err.join("\n"), /Provide BOTH --username and --password/);
    assert.equal(cli.mt.calls.length, 0);
  } finally {
    cli.cleanup();
  }
});

test("a file with half a login is a usage error that names the missing half, before any request", async () => {
  const cli = makeCli();
  try {
    cli.store.set("username", USER);
    assert.equal(await run(["catalogue", "tables", "12411*"], cli.deps), 2);
    assert.match(cli.err.join("\n"), /holds a username but no password; `regstat config set password` stores it/);
    assert.ok(!cli.err.join("\n").includes(USER));
    assert.equal(cli.mt.calls.length, 0);
  } finally {
    cli.cleanup();
  }
});

test("a value in the file the library would not send is refused, named and not shown", async () => {
  const cli = makeCli();
  try {
    mkdirSync(join(cli.dir, "regionalstatistik"), { mode: 0o700 });
    writeFileSync(cli.store.path, JSON.stringify({ token: ` ${TOKEN}` }), { mode: 0o600 });
    assert.equal(await run(["catalogue", "tables", "12411*"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /The token in the credentials file .* is not usable: .*leading or trailing whitespace/);
    assert.ok(!cli.err.join("\n").includes(TOKEN));
    assert.equal(cli.mt.calls.length, 0);
  } finally {
    cli.cleanup();
  }
});

test("a login from the file is kept out of the output, like one from the environment", async () => {
  const cli = makeCli({ responder: () => jsonResponse(fx.loginOk) });
  try {
    cli.store.set("username", fx.loginOk.Username);
    cli.store.set("password", PASS);
    assert.equal(await run(["logincheck"], cli.deps), 0);
    assert.deepEqual(sent(cli), { username: fx.loginOk.Username, password: PASS });
    assert.ok(!cli.out.join("\n").includes(fx.loginOk.Username));
    assert.match(cli.out.join("\n"), /"Username": "\*\*\*"/);
  } finally {
    cli.cleanup();
  }
});

test("a login from the file is kept out of the log on stderr, in either --log-format", async () => {
  for (const format of ["text", "jsonl"]) {
    const cli = makeCli({ responder: () => jsonResponse({ Code: 2, Content: `Nutzer ${USER} / ${PASS} unbekannt`, Type: "ERROR" }, 404) });
    try {
      cli.store.set("username", USER);
      cli.store.set("password", PASS);
      assert.equal(await run(["--log-format", format, "logincheck"], cli.deps), 1, format);
      const err = cli.err.join("\n");
      assert.match(err, /check your credentials/, format);
      assert.match(err, /Nutzer \*\*\* \/ \*\*\* unbekannt/, format);
      assert.ok(!err.includes(USER) && !err.includes(PASS), `${format}: ${err}`);
    } finally {
      cli.cleanup();
    }
  }
});

test("a credentials file others can read is refused, and only when it is needed", async () => {
  const cli = makeCli({ responder: (req) => jsonResponse(req.url.includes("/helloworld/") ? fx.whoami : fx.tablesList) });
  try {
    cli.store.set("token", TOKEN);
    chmodSync(cli.store.path, 0o644);
    assert.equal(await run(["catalogue", "tables", "12411*"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /can be read by others \(mode 644\).*chmod 600/);
    assert.equal(cli.mt.calls.length, 0);
    // A login given another way does not read the file at all, nor does `hello`.
    assert.equal(await run(["--token", TOKEN, "catalogue", "tables", "12411*"], cli.deps), 0);
    const envToken = { ...cli.deps, env: { REGIONALSTATISTIK_API_TOKEN: TOKEN } };
    assert.equal(await run(["catalogue", "tables", "12411*"], envToken), 0);
    assert.equal(await run(["hello"], cli.deps), 0);
  } finally {
    cli.cleanup();
  }
});

test("deps without a credentials store never read a credentials file", async () => {
  const cli = makeCli({ credentials: false, env: { XDG_CONFIG_HOME: "/nonexistent" } });
  try {
    assert.equal(await run(["catalogue", "tables", "12411*"], cli.deps), 2);
    assert.match(cli.err.join("\n"), /needs credentials/);
    assert.equal(cli.mt.calls.length, 0);
    assert.equal(await run(["config", "list"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /built without a credentials file/);
  } finally {
    cli.cleanup();
  }
});

test("the credentials file: where it is, what it refuses, and how it masks", () => {
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: "/x" }), "/x/regionalstatistik/credentials");
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: "relative", HOME: "/home/me" }), "/home/me/.config/regionalstatistik/credentials");
  assert.equal(resolveCredentialsPath({ HOME: "/home/me" }), "/home/me/.config/regionalstatistik/credentials");
  assert.equal(maskCredential("short"), "****");
  assert.equal(credentialValueProblem("with inner spaces"), undefined);
  assert.match(credentialValueProblem("") ?? "", /empty/);
  assert.match(credentialValueProblem("a\u0085b") ?? "", /control character/);
  const dir = mkdtempSync(join(tmpdir(), "regstat-store-"));
  try {
    const path = join(dir, "credentials");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("token"), /not valid JSON/);
    writeFileSync(path, JSON.stringify({ token: 5 }), { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("token"), /not an object of names and strings/);
    writeFileSync(path, JSON.stringify(["token"]), { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("token"), /not an object of names and strings/);
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "credentials"), JSON.stringify({ token: TOKEN }), { mode: 0o600 });
    symlinkSync(join(dir, "real", "credentials"), join(dir, "link"));
    assert.throws(() => new CredentialStore(join(dir, "link")).get("token"), /not a regular file/);
    const store = new CredentialStore(join(dir, "fresh", "credentials"));
    store.set("token", TOKEN);
    store.set("password", PASS);
    assert.deepEqual(JSON.parse(readFileSync(store.path, "utf8")), { password: PASS, token: TOKEN });
    assert.throws(() => store.set("API KEY", TOKEN), /Not a credential name/);
    assert.equal(store.unset("token"), true);
    assert.equal(store.unset("password"), true);
    assert.throws(() => statSync(store.path), /ENOENT/, "the file goes when nothing is left in it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret piped in is read whole, one trailing newline dropped", async () => {
  assert.equal(await readSecretFrom(Readable.from([`${TOKEN}\n`]), { write: () => true }, "token: "), TOKEN);
  assert.equal(await readSecretFrom(Readable.from(["Sommer ", "Regen\r\n"]), { write: () => true }, "password: "), "Sommer Regen");
});

test("maskCredential: a value shows its ends only from 20 characters, a password never (C7)", () => {
  assert.equal(maskCredential("Sommer2026!x"), "****");
  assert.equal(maskCredential("a".repeat(19)), "****");
  assert.equal(maskCredential("abcd0123456789abwxyz"), "abcd…wxyz");
  assert.equal(maskCredential(TOKEN, "token"), "0123…cdef");
  assert.equal(maskCredential("a-very-long-password-of-40-characters!!!", "password"), "****");
});

test("a stored password is never partly shown: not by set, get or list (C7)", async () => {
  for (const secret of ["Sommer2026!x", "a-very-long-password-of-40-characters!!!"]) {
    const cli = makeCli({ secret });
    try {
      assert.equal(await run(["config", "set", "password"], cli.deps), 0, cli.err.join("\n"));
      assert.match(cli.err.join("\n"), /Stored password \(\*\*\*\*\) in /);
      assert.equal(await run(["config", "get", "password"], cli.deps), 0);
      assert.equal(await run(["config", "list"], cli.deps), 0);
      assert.deepEqual(cli.out, ["****", "password  ****"]);
      const all = cli.out.join("\n") + cli.err.join("\n");
      assert.ok(!all.includes(secret.slice(0, 4)) && !all.includes(secret.slice(-4)), all);
    } finally {
      cli.cleanup();
    }
  }
});

test("an unwritable config location names the credentials file, for set and for the last unset (C4)", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions and a non-root user");
  const cli = makeCli({ secret: TOKEN });
  try {
    // The parent of the program's directory cannot be written: mkdir fails.
    const parent = join(cli.dir, "regionalstatistik");
    mkdirSync(cli.dir, { recursive: true });
    chmodSync(cli.dir, 0o500);
    assert.equal(await run(["config", "set", "token"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Could not write the credentials file .*credentials: EACCES/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    chmodSync(cli.dir, 0o700);

    // The last name removed from a file in a directory that cannot be written: rm fails.
    cli.err.length = 0;
    cli.store.set("token", TOKEN);
    chmodSync(parent, 0o500);
    assert.equal(await run(["config", "unset", "token"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Could not write the credentials file .*credentials: EACCES/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    chmodSync(parent, 0o700);
    assert.equal(cli.store.get("token"), TOKEN, "nothing was lost");
  } finally {
    chmodSync(cli.dir, 0o700);
    cli.cleanup();
  }
});

test("config refuses -o: the value goes to stdout only, never silently to the terminal instead of a file (C10)", async () => {
  const cli = makeCli({ secret: TOKEN });
  try {
    cli.store.set("token", TOKEN);
    for (const argv of [
      ["-o", "token.txt", "config", "get", "token", "--reveal"],
      ["config", "get", "token", "--reveal", "-o", "token.txt"],
      ["--output=token.txt", "config", "get", "token"],
      ["-o", "token.txt", "config", "list"],
      ["-o", "token.txt", "config", "set", "token"],
      ["-o", "token.txt", "config", "unset", "token"],
    ]) {
      cli.out.length = 0;
      cli.err.length = 0;
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      assert.deepEqual(cli.out, [], argv.join(" "));
      assert.match(cli.err.join("\n"), /ERROR \[regstat\.cli\] regstat config prints to stdout only/, argv.join(" "));
    }
    assert.equal(cli.store.get("token"), TOKEN, "unset did not run");
    // `-o -` is stdout, as everywhere.
    cli.out.length = 0;
    assert.equal(await run(["-o", "-", "config", "get", "token", "--reveal"], cli.deps), 0);
    assert.deepEqual(cli.out, [TOKEN]);
  } finally {
    cli.cleanup();
  }
});

test("a secret typed in place of the name is never echoed, by any config command (C2)", async () => {
  const cli = makeCli({ secret: TOKEN });
  try {
    const typed = "Hunter2SECRET!pw";
    for (const argv of [
      ["config", "set", typed],
      ["config", "get", typed],
      ["config", "get", typed, "--reveal"],
      ["config", "unset", typed],
      ["config", "get", "password", typed],
      ["config", "unset", "password", typed],
      ["config", "list", typed],
      ["--log-format", "jsonl", "config", "set", typed],
    ]) {
      cli.err.length = 0;
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      const err = cli.err.join("\n");
      assert.ok(!err.includes("SECRET"), `${argv.join(" ")}:\n${err}`);
      assert.match(err, /ERROR.*regstat\.cli/, argv.join(" "));
    }
    cli.err.length = 0;
    assert.equal(await run(["config", "get", typed], cli.deps), 2);
    assert.match(cli.err.join("\n"), /Not a credential name this program knows: expected token, username, password\./);
  } finally {
    cli.cleanup();
  }
});

test("a secret read from stdin stops at 64 KiB and is refused, an endless input included (C3)", async () => {
  await assert.rejects(readSecretFrom(Readable.from([Buffer.alloc(70 * 1024, "a")]), { write: () => true }, "password: "), /longer than 64 KiB; nothing was stored/);
  let chunks = 0;
  async function* zero() {
    for (;;) {
      chunks++;
      yield Buffer.alloc(16 * 1024);
    }
  }
  await assert.rejects(readSecretFrom(Readable.from(zero()), { write: () => true }, "password: "), /longer than 64 KiB/);
  assert.ok(chunks < 10, `read ${chunks} chunks`);
  const exact = "a".repeat(64 * 1024);
  assert.equal(await readSecretFrom(Readable.from([exact + "\n"]), { write: () => true }, "password: "), exact);
});

/** A terminal as far as readSecretFrom needs one: raw mode, data events. */
class FakeTty extends EventEmitter {
  readonly isTTY = true;
  raw = false;
  setRawMode(on: boolean): this {
    this.raw = on;
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

/** What the prompt returns for keystrokes arriving in `reads` (one data event each). */
async function typed(...reads: string[]): Promise<string> {
  const tty = new FakeTty();
  const result = readSecretFrom(tty as unknown as NodeJS.ReadStream, { write: () => true }, "password: ");
  for (const read of reads) tty.emit("data", Buffer.from(read));
  return result;
}

test("the prompt drops escape sequences and keeps what was typed (C1)", async () => {
  assert.equal(await typed("abc\u001b[A\u001b[Ddef\r"), "abcdef", "arrow keys");
  assert.equal(await typed("\u001bOAabc\r"), "abc", "SS3");
  assert.equal(await typed("\u001b[200~my pass word\u001b[201~\r"), "my pass word", "bracketed paste");
  assert.equal(await typed("\u001b[1;5Cabc\r"), "abc", "a CSI with parameters");
  assert.equal(await typed("abc\u001b", "[Adef\r"), "abcdef", "a sequence split across reads");
  assert.equal(await typed("abcd\u007f\r"), "abc", "Backspace");
  assert.equal(await typed("key\r\n"), "key", "CR LF is one line break");
  // A tab is kept: a password may hold one, and the same value from a pipe is stored too.
  assert.equal(await typed("abc\tdef\r"), "abc\tdef");
  await assert.rejects(typed("abc\u0003"), /Interrupted; nothing was stored/);
});

test("the prompt refuses a paste with more after its first line break (C1)", async () => {
  for (const read of ["firstline\nsecondline\n", "key\rsecondline\r", "key\r\nmore"]) {
    await assert.rejects(typed(read), /The value holds a line break; nothing was stored\./, JSON.stringify(read));
  }
});

test("set and unset take credentials.lock: a held lock fails after 2 s, a stale one is taken over (C8)", () => {
  const dir = mkdtempSync(join(tmpdir(), "regstat-lock-"));
  try {
    let clock = 1_000_000;
    const waits: number[] = [];
    const options = { now: () => clock, sleep: (ms: number) => { waits.push(ms); clock += ms; } };
    const path = join(dir, "regionalstatistik", "credentials");
    const store = new CredentialStore(path, options);
    store.set("username", USER);
    assert.equal(existsSync(`${path}.lock`), false, "the lock is released");

    // Another writer holds the lock: retried for 2 s, then refused, nothing changed.
    writeFileSync(`${path}.lock`, "4242");
    utimesSync(`${path}.lock`, clock / 1000, clock / 1000);
    assert.throws(() => store.set("password", PASS), /Another regstat config is writing .*credentials; try again\./);
    assert.ok(waits.length > 1 && waits.reduce((a, b) => a + b, 0) >= 2000, `waited ${waits.join(",")}`);
    assert.throws(() => store.unset("username"), /Another regstat config is writing/);
    assert.deepEqual(store.all(), { username: USER });

    // A lock older than 30 s is left over from a crash: taken over.
    clock += 31_000;
    store.set("password", PASS);
    assert.deepEqual(store.all(), { password: PASS, username: USER });
    assert.equal(existsSync(`${path}.lock`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held lock fails config set with exit 1 and the stored values kept (C8)", async () => {
  const cli = makeCli({ secret: PASS });
  try {
    cli.store.set("username", USER);
    writeFileSync(`${cli.store.path}.lock`, "4242");
    const store = new CredentialStore(cli.store.path, { sleep: () => undefined, now: (() => { let t = Date.now(); return () => (t += 500); })() });
    assert.equal(await run(["config", "set", "password"], { ...cli.deps, credentials: () => store }), 1);
    assert.match(cli.err.join("\n"), /ERROR \[regstat\.config\] Another regstat config is writing/);
    assert.deepEqual(cli.store.all(), { username: USER });
  } finally {
    cli.cleanup();
  }
});

test("config get --reveal prints the value as stored, untouched by the run's redaction (C9)", async () => {
  const cli = makeCli();
  try {
    cli.store.set("password", "my pass word");
    cli.store.set("token", TOKEN);
    // A credential from a variable or a flag that occurs in the stored value.
    assert.equal(await run(["config", "get", "password", "--reveal"], { ...cli.deps, env: { REGIONALSTATISTIK_USERNAME: "word" } }), 0);
    assert.equal(await run(["--password", "word", "config", "get", "password", "--reveal"], cli.deps), 0);
    // The same token exported and stored.
    assert.equal(await run(["config", "get", "token", "--reveal"], { ...cli.deps, env: { REGIONALSTATISTIK_API_TOKEN: TOKEN } }), 0);
    assert.deepEqual(cli.out, ["my pass word", "my pass word", TOKEN]);
  } finally {
    cli.cleanup();
  }
});

test("every stored value is a secret of the run the moment it is read: no record shows it (C5)", async () => {
  const personal = { token: "personal-token-of-another-shape-0123", username: "personal-user-0123", password: "personal pass 0123" };
  for (const names of [["token"], ["username", "password"]] as const) {
    const cli = makeCli();
    try {
      for (const name of names) cli.store.set(name, personal[name]);
      for (const format of ["text", "jsonl"]) {
        cli.err.length = 0;
        // Whatever path a value takes to a message — here a client that quotes them all.
        const deps: CliDeps = {
          ...cli.deps,
          createClient: (opts) => {
            throw new RegionalstatistikError(`could not use ${String(opts.token)} ${String(opts.username)} ${String(opts.password)}`);
          },
        };
        assert.equal(await run(["--log-format", format, "logincheck"], deps), 1);
        const err = cli.err.join("\n");
        assert.ok(!err.includes("personal"), `${format}: ${err}`);
      }
    } finally {
      cli.cleanup();
    }
  }
  // config set reads a value too: it is a secret of its run, should a message quote it.
  const cli = makeCli({ secret: personal.password });
  try {
    const store = new CredentialStore(cli.store.path);
    store.set = (name: string, value: string) => {
      throw new RegionalstatistikError(`could not store ${name}: ${value}`);
    };
    assert.equal(await run(["config", "set", "password"], { ...cli.deps, credentials: () => store }), 1);
    assert.match(cli.err.join("\n"), /could not store password: \*\*\*/);
  } finally {
    cli.cleanup();
  }
});

test("a credential a server echoes URL-encoded on a success is replaced on stdout too, as the library does in errors (destatis-genesis 03-2)", async () => {
  const password = "s3cret+p@ss/w%rd";
  const note = `login=${encodeURIComponent("DEUSER0001")}&pw=${encodeURIComponent(password)}`;
  const cli = makeCli({ responder: () => jsonResponse({ ...fx.loginOk, Username: "DEUSER0001", Note: note }) });
  try {
    cli.store.set("username", "DEUSER0001");
    cli.store.set("password", password);
    assert.equal(await run(["logincheck", "--compact"], cli.deps), 0, cli.err.join("\n"));
    assert.ok(!cli.out.join("\n").includes(encodeURIComponent(password)), cli.out.join("\n"));
    assert.match(cli.out.join("\n"), /"Note":"login=\*\*\*&pw=\*\*\*"/);
    // The same from the variables.
    cli.out.length = 0;
    const viaEnv = { ...cli.deps, env: { REGIONALSTATISTIK_USERNAME: "DEUSER0001", REGIONALSTATISTIK_PASSWORD: password } };
    assert.equal(await run(["logincheck", "--compact"], viaEnv), 0, cli.err.join("\n"));
    assert.match(cli.out.join("\n"), /"Note":"login=\*\*\*&pw=\*\*\*"/);
  } finally {
    cli.cleanup();
  }
});

test("a password with C1 characters that a server echoes is replaced on stdout, in the escaped form stdout prints (#6)", async () => {
  // The credentials file refuses C1 characters (credentialValueProblem); a variable or a
  // flag can still carry one, and the library sends it.
  for (const password of ["pass\u0085word123", "pass\u009bword123"]) {
    const cli = makeCli({ responder: () => jsonResponse({ ...fx.loginOk, Username: USER, Password: password }) });
    try {
      for (const argv of [["logincheck", "--compact"], ["logincheck"]]) {
        cli.out.length = 0;
        const viaEnv = { ...cli.deps, env: { REGIONALSTATISTIK_USERNAME: USER, REGIONALSTATISTIK_PASSWORD: password } };
        assert.equal(await run(argv, viaEnv), 0, cli.err.join("\n"));
        const out = cli.out.join("\n");
        assert.ok(!out.includes("word123"), `${JSON.stringify(password)} ${argv.join(" ")}: ${out}`);
        assert.match(out, /"Password": ?"\*\*\*"/);
      }
      // The same from the flags.
      cli.out.length = 0;
      assert.equal(await run(["--username", USER, "--password", password, "logincheck", "--compact"], cli.deps), 0, cli.err.join("\n"));
      assert.ok(!cli.out.join("\n").includes("word123"), cli.out.join("\n"));
    } finally {
      cli.cleanup();
    }
  }
});

test("a failure of the credentials file is an ERROR record of regstat.config, like its successes (destatis-genesis 04-1)", async () => {
  const cli = makeCli({ secret: TOKEN });
  try {
    const records = async (argv: string[], deps: CliDeps = cli.deps): Promise<Array<Record<string, unknown>>> => {
      cli.err.length = 0;
      await run(["--log-format", "jsonl", ...argv], deps);
      return cli.err.map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    const errorTopic = (rs: Array<Record<string, unknown>>): unknown => rs.find((r) => r["level"] === "ERROR")?.["topic"];
    // Nothing stored: get and unset.
    assert.equal(errorTopic(await records(["config", "get", "token"])), "regstat.config");
    assert.equal(errorTopic(await records(["config", "unset", "token"])), "regstat.config");
    // A file others can read: from config list and from a command that needs the login.
    cli.store.set("token", TOKEN);
    chmodSync(cli.store.path, 0o644);
    for (const argv of [["config", "list"], ["find", "x"]]) {
      const rs = await records(argv);
      assert.equal(errorTopic(rs), "regstat.config", JSON.stringify(rs));
      assert.match(String(rs.find((r) => r["level"] === "ERROR")?.["msg"]), /can be read by others/);
    }
    chmodSync(cli.store.path, 0o600);
    // A stored value the library refuses.
    writeFileSync(cli.store.path, JSON.stringify({ token: ` ${TOKEN}` }), { mode: 0o600 });
    assert.equal(errorTopic(await records(["find", "x"])), "regstat.config");
    // The success is config too.
    rmSync(cli.store.path);
    const stored = await records(["config", "set", "token"]);
    assert.deepEqual([stored[0]?.["level"], stored[0]?.["topic"]], ["INFO", "regstat.config"]);
    // A usage error of config stays cli.
    assert.equal(errorTopic(await records(["config", "get", "nope"])), "regstat.cli");
  } finally {
    cli.cleanup();
  }
});
