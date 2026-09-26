import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { RegionalstatistikClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse, bodyOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function makeCli(
  responder: (req: HttpRequest) => HttpResponse,
  env: Record<string, string | undefined> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => files.set(p, d),
      fileExists: (p) => files.has(p),
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => new RegionalstatistikClient({ ...opts, transport: mt.transport }),
    env,
  };
  return { deps, out, err, files, mt };
}

const TOKEN = ["--token", "0123456789abcdef0123456789abcdef"];

test("hello works without credentials and hits whoami", async () => {
  const cli = makeCli(() => jsonResponse(fx.whoami));
  const code = await run(["hello"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/genesisws/rest/2020/helloworld/whoami");
  assert.deepEqual(JSON.parse(cli.out.join("\n")), fx.whoami);
});

test("a credential-required command with no credentials exits 2 and issues no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  const code = await run(["catalogue", "tables", "12411"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /needs credentials/);
});

test("only one of --username/--password exits 2 before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  const code = await run(["catalogue", "tables", "--username", "USER123456"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /BOTH --username and --password/);
});

test("--token sends the token in the username header", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  const code = await run([...TOKEN, "catalogue", "tables", "12411*"], cli.deps);
  assert.equal(code, 0);
  const req = cli.mt.last();
  assert.equal(req.headers?.["username"], "0123456789abcdef0123456789abcdef");
  assert.equal(req.headers?.["password"], undefined);
  assert.equal(bodyOf(req).get("selection"), "12411*");
});

test("a credential passed via --token warns to stderr, recommending the env var", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  const code = await run([...TOKEN, "catalogue", "tables", "12411*"], cli.deps);
  assert.equal(code, 0);
  const errText = cli.err.join("\n");
  assert.match(errText, /command line are visible in the process list/);
  assert.match(errText, /REGIONALSTATISTIK_API_TOKEN/);
  // The credential value itself is never printed.
  assert.doesNotMatch(errText, /0123456789abcdef/);
});

test("a credential from the environment does NOT trigger the argv warning", async () => {
  const cli = makeCli(() => jsonResponse(fx.findResult), {
    REGIONALSTATISTIK_API_TOKEN: "envtoken0000000000000000000000ab",
  });
  const code = await run(["find", "Bevölkerung"], cli.deps);
  assert.equal(code, 0);
  assert.doesNotMatch(cli.err.join("\n"), /visible in the process list/);
});

test("REGIONALSTATISTIK_USERNAME/PASSWORD from the environment seed the credentials", async () => {
  const cli = makeCli(() => jsonResponse(fx.findResult), {
    REGIONALSTATISTIK_USERNAME: "ENVUSER123",
    REGIONALSTATISTIK_PASSWORD: "ENVPASS456",
  });
  const code = await run(["find", "Bevölkerung Kreise"], cli.deps);
  assert.equal(code, 0);
  const req = cli.mt.last();
  assert.equal(req.headers?.["username"], "ENVUSER123");
  assert.equal(req.headers?.["password"], "ENVPASS456");
  assert.equal(bodyOf(req).get("term"), "Bevölkerung Kreise");
  assert.equal(new URL(req.url).pathname, "/genesisws/rest/2020/find/find");
});

test("an explicit --token overrides REGIONALSTATISTIK_API_TOKEN from the environment", async () => {
  const cli = makeCli(() => jsonResponse(fx.findResult), { REGIONALSTATISTIK_API_TOKEN: "envtoken" });
  await run([...TOKEN, "find", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["username"], "0123456789abcdef0123456789abcdef");
});

test("a control character in --user-agent is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.whoami));
  const code = await run(["hello", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /control character/i);
});

test("a control character in a credential (--token) is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  const code = await run(["--token", "tok\r\nX-Injected: 1", "catalogue", "tables"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("a control character in an env credential is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList), {
    REGIONALSTATISTIK_API_TOKEN: `tok${String.fromCharCode(0x0d)}${String.fromCharCode(0x0a)}X-Injected: 1`,
  });
  const code = await run(["catalogue", "tables", "12411"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /REGIONALSTATISTIK_API_TOKEN contains control characters/);
});

test("a blank <term> on find is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.findResult));
  const code = await run([...TOKEN, "find", "   "], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

// A blank filter/selection/code (often an unset shell variable) is never
// meaningful: it must be a usage error before any request, not an empty
// `area=` / `selection=` sent in the POST body.
const BLANK_CASES: { label: string; argv: string[] }[] = [
  { label: "catalogue [selection]", argv: ["catalogue", "tables", ""] },
  { label: "catalogue [selection] (whitespace)", argv: ["catalogue", "cubes", "   "] },
  { label: "catalogue --area", argv: ["catalogue", "tables", "12411*", "--area", ""] },
  { label: "catalogue --type", argv: ["catalogue", "values", "--type", ""] },
  { label: "metadata --area", argv: ["metadata", "table", "12411-01-01-4", "--area", ""] },
  { label: "data --area", argv: ["data", "table", "12411-01-01-4", "--area", ""] },
  { label: "data --start-year", argv: ["data", "table", "12411-01-01-4", "--start-year", ""] },
  { label: "data --end-year (whitespace)", argv: ["data", "cube", "X", "--end-year", "  "] },
  { label: "data --region-var", argv: ["data", "table", "X", "--region-var", ""] },
  { label: "data --region-key", argv: ["data", "tablefile", "X", "--region-key", ""] },
  { label: "data --contents", argv: ["data", "timeseries", "X", "--contents", ""] },
  { label: "data --stand", argv: ["data", "result", "X", "--stand", ""] },
  ...[1, 2, 3, 4, 5].flatMap((i) => [
    { label: `data --class-var${i}`, argv: ["data", "table", "X", `--class-var${i}`, ""] },
    { label: `data --class-key${i}`, argv: ["data", "cubefile", "X", `--class-key${i}`, ""] },
  ]),
];

for (const { label, argv } of BLANK_CASES) {
  test(`a blank value for ${label} is rejected before any request`, async () => {
    const cli = makeCli(() => jsonResponse(fx.tablesList));
    const code = await run([...TOKEN, ...argv], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0);
  });
}

test("--pagelength above the server cap (25000) is rejected client-side", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  const code = await run([...TOKEN, "--pagelength", "25001", "catalogue", "tables"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("--max-retries above the sane maximum is rejected client-side", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  const code = await run([...TOKEN, "--max-retries", "1000000", "catalogue", "tables"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("data table sends the object name and regional filters to data/table", async () => {
  const cli = makeCli(() => jsonResponse(fx.dataTable));
  const code = await run(
    [...TOKEN, "data", "table", "12411-01-01-4", "--start-year", "2020", "--region-var", "KREISE", "--region-key", "08*"],
    cli.deps,
  );
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/genesisws/rest/2020/data/table");
  const body = bodyOf(cli.mt.last());
  assert.equal(body.get("name"), "12411-01-01-4");
  assert.equal(body.get("startyear"), "2020");
  assert.equal(body.get("regionalvariable"), "KREISE");
  assert.equal(body.get("regionalkey"), "08*");
});

test("a GENESIS logical error (HTTP 200 + Status Fehler) exits 1", async () => {
  const cli = makeCli(() => jsonResponse(fx.genericError));
  const code = await run([...TOKEN, "data", "table", "12411-01-01-4"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /GENESIS status -1/);
});

test("a flat Code 15 auth error exits 1 with a credentials hint, not a stack trace", async () => {
  const cli = makeCli(() => jsonResponse(fx.flatNotAuthorized));
  const code = await run([...TOKEN, "catalogue", "tables", "12411*"], cli.deps);
  assert.equal(code, 1);
  const errText = cli.err.join("\n");
  assert.match(errText, /GENESIS status 15/);
  assert.match(errText, /nicht berechtigt/);
  assert.match(errText, /Hint: check your credentials/);
  assert.doesNotMatch(errText, /Unexpected error/);
});

test("the live 401 + flat Code 15 reply exits 1 with a credentials hint", async () => {
  const cli = makeCli(() => jsonResponse(fx.flatNotAuthorized, 401));
  const code = await run([...TOKEN, "catalogue", "tables", "12411*"], cli.deps);
  assert.equal(code, 1);
  const errText = cli.err.join("\n");
  assert.match(errText, /GENESIS status 15/);
  assert.match(errText, /Hint: check your credentials/);
});

test("the live 404 + flat Code 2 reply (bad credentials) exits 1, not 4", async () => {
  const cli = makeCli(() => jsonResponse(fx.flatBadCredentials, 404));
  const code = await run([...TOKEN, "catalogue", "tables", "12411*"], cli.deps);
  assert.equal(code, 1);
  const errText = cli.err.join("\n");
  assert.match(errText, /GENESIS status 2/);
  assert.match(errText, /Nutzernamen/);
  assert.doesNotMatch(errText, /Unexpected error/);
});

test("a not-found (Status.Code 90) exits 4", async () => {
  const cli = makeCli(() => jsonResponse(fx.notFound));
  const code = await run([...TOKEN, "metadata", "table", "99999-99-99-4"], cli.deps);
  assert.equal(code, 4);
});

test("data tablefile with a Status.Code 104 reply (unknown code) exits 4 and writes no file", async () => {
  const cli = makeCli(() => jsonResponse(fx.emptyResult));
  const code = await run([...TOKEN, "data", "tablefile", "99999-99", "-o", "t.zip"], cli.deps);
  assert.equal(code, 4);
  assert.equal(cli.files.size, 0);
  assert.match(cli.err.join("\n"), /GENESIS status 104/);
  assert.doesNotMatch(cli.err.join("\n"), /Wrote/);
});

test("data tablefile with an error reply labelled text/plain exits non-zero and writes no file", async () => {
  const cli = makeCli(() => rawResponse(JSON.stringify(fx.genericError), "text/plain;charset=UTF-8"));
  const code = await run([...TOKEN, "data", "tablefile", "12411-01-01-4", "-o", "t.zip"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.files.size, 0);
  assert.match(cli.err.join("\n"), /GENESIS status -1 \(Fehler\)/);
});

test("data tablefile with an empty body exits 1 and writes no file", async () => {
  const cli = makeCli(() => rawResponse("", "application/zip"));
  const code = await run([...TOKEN, "data", "tablefile", "12411-01-01-4", "-o", "t.zip"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.files.size, 0);
  assert.match(cli.err.join("\n"), /Empty response body/);
});

test("--output writes JSON to a file and keeps stdout clean", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  const code = await run([...TOKEN, "--output", "/tmp/out.json", "catalogue", "tables"], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.files.get("/tmp/out.json")?.toString("utf8") ?? "", /12411-01-01-4/);
  assert.equal(cli.out.length, 0);
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes to \/tmp\/out\.json/);
});

test("--output refuses to overwrite an existing file without --force", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  cli.files.set("/tmp/out.json", Buffer.from("existing"));
  const code = await run([...TOKEN, "--output", "/tmp/out.json", "catalogue", "tables"], cli.deps);
  assert.equal(code, 2);
  // The pre-existing file is untouched, and nothing was written to stdout.
  assert.equal(cli.files.get("/tmp/out.json")?.toString("utf8"), "existing");
  assert.equal(cli.out.length, 0);
  assert.match(cli.err.join("\n"), /Refusing to overwrite/);
});

test("--force allows overwriting an existing --output file", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  cli.files.set("/tmp/out.json", Buffer.from("existing"));
  const code = await run([...TOKEN, "--force", "--output", "/tmp/out.json", "catalogue", "tables"], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.files.get("/tmp/out.json")?.toString("utf8") ?? "", /12411-01-01-4/);
});

test("a filesystem write error surfaces as a typed usage error, not Unexpected", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  cli.deps.io.writeFile = () => {
    throw new Error("EACCES: permission denied, open '/root/out.json'");
  };
  const code = await run([...TOKEN, "--output", "/root/out.json", "catalogue", "tables"], cli.deps);
  assert.equal(code, 2);
  assert.match(cli.err.join("\n"), /Could not write to .*EACCES/);
  assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
});

test("an empty --output is rejected instead of silently writing to stdout", async () => {
  const cli = makeCli(() => jsonResponse(fx.whoami));
  const code = await run(["hello", "--output", ""], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.equal(cli.out.length, 0);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { "User-Agent": `regstat${controls}`, "User-IP": String.fromCharCode(0x1b) + "[31m" };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "hello"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) =>
      c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f,
    );
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /regstat\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  await run([...TOKEN, "--compact", "catalogue", "tables"], cli.deps);
  assert.equal(cli.out.length, 1);
  assert.equal(cli.out[0], JSON.stringify(fx.tablesList));
});

test("logincheck requires credentials", async () => {
  const cli = makeCli(() => jsonResponse(fx.loginOk));
  const code = await run(["logincheck"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--help exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--help"], cli.deps), 0);
});

test("a commander usage error (bad option value) exits 2, not 1", async () => {
  const cli = makeCli(() => jsonResponse(fx.tablesList));
  const code = await run([...TOKEN, "--pagelength", "0", "catalogue", "tables"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(fx.whoami));
  assert.equal(await run(["--timeout", "2147483647", "hello"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(fx.whoami));
  assert.equal(await run(["--timeout", "2147483648", "hello"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("a missing required argument exits 2", async () => {
  const cli = makeCli(() => jsonResponse(fx.findResult));
  assert.equal(await run([...TOKEN, "find"], cli.deps), 2);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});

test("a non-http(s) --base-url is rejected at parse time with exit 2", async () => {
  const cli = makeCli(() => jsonResponse(fx.whoami));
  const code = await run(["--base-url", "file:///etc/passwd", "hello"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a --base-url with embedded userinfo is rejected at parse time", async () => {
  const cli = makeCli(() => jsonResponse(fx.whoami));
  const code = await run(["--base-url", "https://USER:PASS@www.regionalstatistik.de", "hello"], cli.deps);
  // Rejected before any request is issued, with the conventional usage exit
  // code. (commander echoes the user's own argv value in its usage error; the
  // leak this closes is credentials reaching *API error messages / CI logs* on
  // a later HTTP error, which redactUrl also masks.)
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Must not embed credentials/);
});
