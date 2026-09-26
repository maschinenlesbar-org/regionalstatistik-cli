import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIO } from "../src/cli/io.js";

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
