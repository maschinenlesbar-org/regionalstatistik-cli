// `regstat config` and the credentials file: the GENESIS login kept apart from argv
// and the environment, the same mechanism as openka-cli's `ka config` and
// dip-bundestag-cli's `dip config`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { run } from "../src/cli/run.js";
import { RegionalstatistikClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import { readSecretFrom } from "../src/cli/io.js";
import { CredentialStore, credentialValueProblem, maskCredential, resolveCredentialsPath } from "../src/cli/credentials.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";
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
      assert.ok(cli.err.join("\n").includes(`Stored ${name} (${mask}) in `));
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
      assert.match(cli.err.join("\n"), /Credentials file: .*regionalstatistik\/credentials/);

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
