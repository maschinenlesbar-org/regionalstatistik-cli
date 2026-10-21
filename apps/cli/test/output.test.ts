// `-o` and `--force` (K7 of the kit rollout 2026-10-21): the target is checked before any
// request, and the write is atomic. The cases run through run() against real files in a temp
// dir, with the real file seam (defaultIO); a write cut short is conformance test P26's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/run.js";
import { defaultIO, type CliDeps } from "../src/cli/io.js";
import { RegionalstatistikClient } from "@maschinenlesbar.org/regionalstatistik-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/regionalstatistik-client/internal/http";
import * as fx from "@maschinenlesbar.org/regionalstatistik-client/test/fixtures";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";

const TOKEN = ["--token", "0123456789abcdef0123456789abcdef"];

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse(fx.whoami)) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(untimed(s)),
      writeFile: defaultIO.writeFile,
      fileState: defaultIO.fileState,
      parentProblem: defaultIO.parentProblem,
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    env: {},
    createClient: (opts) => new RegionalstatistikClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

/** Run `body` with a fresh temp directory that is always removed. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "regionalstatistik-output-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("-o writes what stdout would show, plus a newline, and leaves no temporary file", async () => {
  await inTempDir(async (dir) => {
    const shown = makeCli();
    assert.equal(await run(["hello"], shown.deps), 0);
    const path = join(dir, "whoami.json");
    const cli = makeCli();
    assert.equal(await run(["-o", path, "hello"], cli.deps), 0);
    const written = readFileSync(path, "utf8");
    assert.equal(written, `${shown.out.join("\n")}\n`);
    assert.deepEqual(cli.out, []);
    assert.deepEqual(cli.err, [`INFO  [regstat.output] Wrote ${Buffer.byteLength(written)} bytes to ${path}`]);
    assert.deepEqual(readdirSync(dir), ["whoami.json"]);
  });
});

test("a refused -o target is a usage error before any request", async () => {
  await inTempDir(async (dir) => {
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "keep");
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const refuse = (path: string) =>
      `Refusing to overwrite existing file "${path}". Pass --force to overwrite, or choose a different --output path.`;
    const isDir = (path: string) => `"${path}" is a directory; give a file path to --output.`;
    const cases: Array<[string[], string]> = [
      [["--force", "hello"], "ERROR [regstat.output] --force needs --output (it only allows overwriting the -o file)."],
      [[...TOKEN, "--force", "find", "x"], "ERROR [regstat.output] --force needs --output (it only allows overwriting the -o file)."],
      [["-o", existing, "hello"], `ERROR [regstat.output] ${refuse(existing)}`],
      [["-o", dangling, "hello"], `ERROR [regstat.output] ${refuse(dangling)}`],
      [["-o", sub, "hello"], `ERROR [regstat.output] ${isDir(sub)}`],
      [["-o", sub, "--force", "hello"], `ERROR [regstat.output] ${isDir(sub)}`],
      [["-o", existing, ...TOKEN, "find", "x"], `ERROR [regstat.output] ${refuse(existing)}`],
      [["-o", sub, ...TOKEN, "data", "tablefile", "12411-01-01-4"], `ERROR [regstat.output] ${isDir(sub)}`],
      [["-o", existing, ...TOKEN, "data", "tablefile", "12411-01-01-4"], `ERROR [regstat.output] ${refuse(existing)}`],
    ];
    for (const [argv, record] of cases) {
      const cli = makeCli();
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
      assert.ok(cli.err.includes(record), `${argv.join(" ")}: ${cli.err.join(" | ")}`);
    }
    assert.equal(readFileSync(existing, "utf8"), "keep");
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "existing.json", "sub"]);
  });
});

test("-o - prints to stdout, with or without --force, and creates no file", async () => {
  await inTempDir(async (dir) => {
    const cli = makeCli();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(await run(["--compact", "-o", "-", "hello"], cli.deps), 0);
      assert.equal(await run(["--compact", "-o", "-", "--force", "hello"], cli.deps), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(cli.out.length, 2);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("--force replaces an existing file, keeps its mode, and writes through a symlink", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o600);
    assert.equal(await run(["--compact", "-o", path, "--force", "hello"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), fx.whoami);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(dir, "latest.json");
    symlinkSync(path, link);
    const other = { ...fx.whoami, "User-Agent": "another-agent" };
    assert.equal(await run(["--compact", "-o", link, "--force", "hello"], makeCli(() => jsonResponse(other)).deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), other);
    assert.ok(statSync(link).isFile() && readdirSync(dir).includes("latest.json"));
    assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "out.json"]);
  });
});

test("--force to a new path creates the file; through a dangling link it creates the file the link names (D1)", async () => {
  await inTempDir(async (dir) => {
    const fresh = join(dir, "fresh.json");
    assert.equal(await run(["--compact", "-o", fresh, "--force", "hello"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), fx.whoami);
    // "--force writes through a symlink", also when the file it points at doesn't exist yet; a
    // relative link is resolved from the link's directory, through a chain of links.
    mkdirSync(join(dir, "sub"));
    symlinkSync("sub/nowhere.json", join(dir, "hop.json"));
    const dangling = join(dir, "dangling.json");
    symlinkSync("hop.json", dangling);
    assert.equal(await run(["--compact", "-o", dangling, "--force", "hello"], makeCli().deps), 0);
    assert.ok(lstatSync(dangling).isSymbolicLink(), "the link stays a link");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "sub", "nowhere.json"), "utf8")), fx.whoami);
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "fresh.json", "hop.json", "sub"]);
    assert.deepEqual(readdirSync(join(dir, "sub")), ["nowhere.json"], "no temporary file is left");
  });
});

test("a target whose directory can't take the file is a usage error before any request (D5)", async () => {
  await inTempDir(async (dir) => {
    const file = join(dir, "file.json");
    writeFileSync(file, "x");
    const readOnly = join(dir, "ro");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o555);
    const loop = join(dir, "loop.json");
    symlinkSync("loop.json", loop);
    const danglingIntoMissing = join(dir, "away.json");
    symlinkSync("missing/x.json", danglingIntoMissing);
    const cases: Array<[string[], RegExp]> = [
      [["-o", join(dir, "missing", "x.json")], /the directory ".*missing" does not exist\./],
      [["-o", join(file, "x.json")], /".*file\.json" is not a directory\./],
      [["-o", join(readOnly, "x.json")], /no permission to create files in ".*ro"\./],
      [["-o", danglingIntoMissing, "--force"], /the directory ".*missing" does not exist\./],
      [["-o", loop, "--force"], /too many levels of symbolic links/],
    ];
    try {
      for (const [argv, message] of cases) {
        for (const command of [["hello"], ["--token", "0123456789abcdef0123456789abcdef", "data", "tablefile", "12411-0001"]]) {
          const cli = makeCli();
          assert.equal(await run([...argv, ...command], cli.deps), 2, argv.join(" "));
          assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
          assert.match(cli.err.join("\n"), /^ERROR \[regstat\.output\] Cannot write to "/, argv.join(" "));
          assert.match(cli.err.join("\n"), message, argv.join(" "));
        }
      }
    } finally {
      chmodSync(readOnly, 0o755);
    }
  });
});

test("a file name of up to 255 bytes is written: the temporary name stays within NAME_MAX (D5)", async () => {
  await inTempDir(async (dir) => {
    for (const name of [`${"x".repeat(250)}.json`, `${"ü".repeat(125)}.json`, `${"😀".repeat(62)}.json`]) {
      assert.ok(Buffer.byteLength(name) <= 255, name);
      const path = join(dir, name);
      const cli = makeCli();
      assert.equal(await run(["--compact", "-o", path, "hello"], cli.deps), 0, cli.err.join("\n"));
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), fx.whoami);
      assert.equal(await run(["--compact", "-o", path, "--force", "hello"], makeCli().deps), 0);
    }
    assert.equal(readdirSync(dir).length, 3, "no temporary file is left");
  });
});

test("a stream target (/dev/null) needs no --force and is written in place (D5)", async () => {
  for (const argv of [["-o", "/dev/null"], ["-o", "/dev/null", "--force"]]) {
    const cli = makeCli();
    assert.equal(await run([...argv, "hello"], cli.deps), 0, cli.err.join("\n"));
    assert.equal(cli.mt.calls.length, 1);
    assert.match(cli.err.join("\n"), /^INFO  \[regstat\.output\] Wrote \d+ bytes to \/dev\/null$/);
  }
  assert.ok(statSync("/dev/null").isCharacterDevice(), "/dev/null is still the device");
});

test("a file that appears during the request is not overwritten: exit 1, an ERROR of the output area", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "race.json");
    const cli = makeCli(() => {
      writeFileSync(path, "theirs");
      return jsonResponse(fx.whoami);
    });
    assert.equal(await run(["-o", path, "hello"], cli.deps), 1);
    assert.equal(readFileSync(path, "utf8"), "theirs");
    assert.deepEqual(cli.err, [
      `ERROR [regstat.output] Refusing to overwrite existing file "${path}". Pass --force to overwrite, or choose a different --output path.`,
    ]);
    assert.deepEqual(readdirSync(dir), ["race.json"]);
  });
});

test("a write the file system refuses is an ERROR of the output area naming the file, not the temporary one; exit 1, the old file kept", async () => {
  await inTempDir(async (dir) => {
    const sub = join(dir, "gone");
    mkdirSync(sub);
    const missing = join(sub, "out.json");
    // The directory is there when -o is checked, and gone when the answer is written.
    const cli = makeCli(() => {
      rmSync(sub, { recursive: true });
      return jsonResponse(fx.whoami);
    });
    assert.equal(await run(["-o", missing, "hello"], cli.deps), 1);
    assert.equal(cli.err.length, 1);
    assert.match(cli.err[0]!, /^ERROR \[regstat\.output\] Could not write to ".*out\.json": ENOENT: no such file or directory$/);

    // A directory that can't take the temporary file: the old file stays as it was, nothing is left.
    const locked = join(dir, "locked");
    mkdirSync(locked);
    const keep = join(locked, "keep.json");
    writeFileSync(keep, "previous");
    chmodSync(locked, 0o555);
    try {
      const forced = makeCli();
      assert.equal(await run(["-o", keep, "--force", "hello"], forced.deps), 2);
      assert.match(forced.err[0] ?? "", /^ERROR \[regstat\.output\] Cannot write to ".*keep\.json": no permission to create files in/);
      assert.equal(forced.mt.calls.length, 0);
      assert.equal(readFileSync(keep, "utf8"), "previous");
      assert.deepEqual(readdirSync(locked), ["keep.json"]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
