import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIO, handleOutputErrors } from "../src/cli/io.js";

function epipe(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function setup() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
  );
  return { stdout, stderr, exits };
}

test("EPIPE on stdout (reader closed early, e.g. | head) exits 0 instead of crashing", () => {
  const s = setup();
  // Without a listener, emitting 'error' would throw — the raw stack trace of the bug.
  s.stdout.emit("error", epipe("EPIPE"));
  assert.deepEqual(s.exits, [0]);
});

test("EPIPE on stderr is ignored, so the run's own exit code stands", () => {
  const s = setup();
  s.stderr.emit("error", epipe("EPIPE"));
  assert.deepEqual(s.exits, []);
});

test("ENOTCONN (stdout is a socket whose peer has gone) counts as the reader going away", () => {
  const out = setup();
  out.stdout.emit("error", epipe("ENOTCONN"));
  assert.deepEqual(out.exits, [0]);
  const err = setup();
  err.stderr.emit("error", epipe("ENOTCONN"));
  assert.deepEqual(err.exits, []);
});

test("another stderr write error exits 1", () => {
  const s = setup();
  s.stderr.emit("error", epipe("EIO"));
  assert.deepEqual(s.exits, [1]);
});

test("defaultIO: a dangling symlink counts as existing and is never written through without --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "regionalstatistik-io-"));
  try {
    const target = join(dir, "target-created.txt");
    const link = join(dir, "dangling");
    symlinkSync(target, link);
    assert.equal(defaultIO.fileExists(link), true);
    assert.throws(
      () => defaultIO.writeFile(link, Buffer.from("x"), false),
      (err: NodeJS.ErrnoException) => err.code === "EEXIST",
    );
    assert.equal(existsSync(target), false);

    const plain = join(dir, "plain.json");
    assert.equal(defaultIO.fileExists(plain), false);
    defaultIO.writeFile(plain, Buffer.from("one"), false);
    assert.throws(() => defaultIO.writeFile(plain, Buffer.from("two"), false), /EEXIST/);
    defaultIO.writeFile(plain, Buffer.from("three"), true);
    assert.equal(readFileSync(plain, "utf8"), "three");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
