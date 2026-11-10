import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIO, handleOutputErrors, nodeFilesFor, stderrAfterStdout, type LinkOwners } from "../src/cli/io.js";
import { createLogger } from "../src/cli/log.js";

function epipe(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function setup() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
    log,
  );
  return { stdout, stderr, exits, records };
}

test("another stdout write error is an ERROR record of regstat.output, in the run's format, and exits 1", () => {
  const s = setup();
  s.stdout.emit("error", epipe("EBADF"));
  assert.deepEqual(s.exits, [1]);
  assert.deepEqual(s.records.map((line) => JSON.parse(line)), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "regstat.output", msg: "Could not write to stdout: write EBADF" },
  ]);
});

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
    assert.equal(defaultIO.fileState(link), "exists");
    assert.throws(
      () => defaultIO.writeFile(link, Buffer.from("x"), false),
      (err: NodeJS.ErrnoException) => err.code === "EEXIST",
    );
    assert.equal(existsSync(target), false);

    const plain = join(dir, "plain.json");
    assert.equal(defaultIO.fileState(plain), "absent");
    defaultIO.writeFile(plain, Buffer.from("one"), false);
    assert.throws(
      () => defaultIO.writeFile(plain, Buffer.from("two"), false),
      (err: NodeJS.ErrnoException) => err.code === "EEXIST" && /^Refusing to overwrite existing file/.test(err.message),
    );
    defaultIO.writeFile(plain, Buffer.from("three"), true);
    assert.equal(readFileSync(plain, "utf8"), "three");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stdout as far as the hold needs one: a backlog, and the events that end it. */
class FakeStdout extends EventEmitter {
  writableLength = 0;
}

test("stderr waits for stdout: a record is held while stdout has a backlog, and flushed in order (L11)", () => {
  const stdout = new FakeStdout();
  const written: string[] = [];
  const err = stderrAfterStdout(stdout, (text: string) => written.push(text));
  err("first");
  assert.deepEqual(written, ["first"], "no backlog: written at once");
  stdout.writableLength = 65536;
  err("second");
  err("third");
  assert.deepEqual(written, ["first"], "held while stdout has a backlog");
  stdout.writableLength = 0;
  stdout.emit("drain");
  assert.deepEqual(written, ["first", "second", "third"]);
  // Flushed on close and on error too, never lost.
  stdout.writableLength = 10;
  err("fourth");
  stdout.emit("close");
  stdout.writableLength = 10;
  err("fifth");
  stdout.emit("error", new Error("EPIPE"));
  assert.deepEqual(written, ["first", "second", "third", "fourth", "fifth"]);
});

// ---- --force and other users' links (class G of the 2026-10-27 security audit) ----------

/** The caller, and another user who planted links. */
const ME = 1000;
const OTHER = 1001;
/** /tmp: owned by root, sticky and world-writable. */
const SHARED = { uid: 0, mode: 0o41777 };

/** Owners as a test says: link owners (the caller otherwise), directory owners and modes (the caller's, 0o40755, otherwise). */
function owners(links: Record<string, number>, dirs: Record<string, { uid: number; mode: number }>): LinkOwners {
  return {
    uid: ME,
    ownerOf: (path, follow) => (follow ? (dirs[path] ?? { uid: ME, mode: 0o40755 }) : { uid: links[path] ?? ME, mode: 0o120777 }),
  };
}

/** A temporary directory with a victim file and a link `out.json` to it. */
function planted(): { dir: string; victim: string; link: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "destatis-links-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "keep me\n");
  const link = join(dir, "out.json");
  symlinkSync(victim, link);
  return { dir, victim, link, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("--force does not follow a link another user made in a directory others can write to, at every hop", () => {
  const t = planted();
  try {
    for (const dirMode of [SHARED, { uid: ME, mode: 0o40777 }]) {
      const files = nodeFilesFor(owners({ [t.link]: OTHER }, { [t.dir]: dirMode }));
      assert.match(files.parentProblem(t.link, true) ?? "", /another user/);
      assert.throws(() => files.write(t.link, Buffer.from("x"), true), /another user/);
      assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
      assert.ok(lstatSync(t.link).isSymbolicLink());
    }
    // own link -> a foreign link in the shared directory -> the victim
    const inner = join(t.dir, "inner");
    symlinkSync(t.victim, inner);
    const outer = join(t.dir, "outer.json");
    symlinkSync(inner, outer);
    assert.throws(() => nodeFilesFor(owners({ [inner]: OTHER }, { [t.dir]: SHARED })).write(outer, Buffer.from("x"), true), /another user/);
    // A foreign dangling link: the file it names is not created.
    const dangling = join(t.dir, "dangling.json");
    const target = join(t.dir, "created-elsewhere.json");
    symlinkSync(target, dangling);
    assert.throws(() => nodeFilesFor(owners({ [dangling]: OTHER }, { [t.dir]: SHARED })).write(dangling, Buffer.from("x"), true), /another user/);
    assert.throws(() => statSync(target));
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
  } finally {
    t.done();
  }
});

test("--force still follows the caller's own links, the directory owner's, and any link in a directory only its owner writes", () => {
  const cases: Array<[string, (t: ReturnType<typeof planted>) => LinkOwners]> = [
    ["the caller's own link in a shared directory", (t) => owners({}, { [t.dir]: SHARED })],
    ["a link of the shared directory's owner", (t) => owners({ [t.link]: 0 }, { [t.dir]: SHARED })],
    ["another user's link in a directory only its owner writes", (t) => owners({ [t.link]: OTHER }, { [t.dir]: { uid: OTHER, mode: 0o40755 } })],
    ["another user's link where no caller id exists", (t) => ({ ...owners({ [t.link]: OTHER }, { [t.dir]: SHARED }), uid: undefined })],
  ];
  for (const [label, who] of cases) {
    const t = planted();
    try {
      const files = nodeFilesFor(who(t));
      assert.equal(files.parentProblem(t.link, true), undefined, label);
      files.write(t.link, Buffer.from("new\n"), true);
      assert.equal(readFileSync(t.victim, "utf8"), "new\n", label);
      assert.ok(lstatSync(t.link).isSymbolicLink(), label);
    } finally {
      t.done();
    }
  }
});

test("a path that can't be inspected is reported as such, not as an existing file", { skip: process.getuid?.() === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "destatis-links-"));
  const closed = join(dir, "closed");
  try {
    mkdirSync(closed);
    const link = join(dir, "out.json");
    symlinkSync(join(closed, "x.json"), link);
    chmodSync(closed, 0o000);
    assert.throws(() => defaultIO.fileState(link), (err: unknown) => err instanceof Error && /^Cannot write to ".*out\.json": EACCES/.test(err.message));
  } finally {
    chmodSync(closed, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stream target is written only when the descriptor opened is a stream", () => {
  // The path was a stream when it was classified and is a regular file (through a link) when it
  // is opened: it was appended to without --force (class G2 of the 2026-10-27 security audit).
  const t = planted();
  try {
    const real = nodeFilesFor();
    const switched = { ...real, state: () => "stream" as const };
    assert.throws(() => switched.write(t.link, Buffer.from("appended\n"), false), /Refusing to overwrite/);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    // A real stream is still written in place.
    assert.doesNotThrow(() => real.write("/dev/null", Buffer.from("x"), false));
  } finally {
    t.done();
  }
});
