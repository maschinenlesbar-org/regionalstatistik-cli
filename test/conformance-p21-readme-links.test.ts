// Conformance test P21 (follow-up round 2026-10-06): README.md ships in the npm tarball and is
// shown on npmjs.com, so every relative link in it must point to a file the package ships;
// anything else has to be an absolute GitHub URL. Dependency-free: reads package.json `files`
// instead of running `npm pack`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---- adapter (per repo) -------------------------------------------------------------
/** The repository root, seen from the compiled test (dist/test/*.js). */
const ROOT = new URL("../../", import.meta.url);
/** Where a link to an unshipped document should point instead. */
const GITHUB_BLOB = "https://github.com/maschinenlesbar-org/regionalstatistik-cli/blob/main/";
// --------------------------------------------------------------------------------------

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

/** The relative link targets of a markdown text, anchors and titles stripped. */
function relativeTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = match[1]!;
    if (target === "" || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    targets.push(target.replace(/#.*$/, "").replace(/^\.\//, ""));
  }
  return targets;
}

/** True when npm packs `path` given `files`: always-shipped names, plain paths, dir prefixes. */
function shipped(path: string, files: readonly string[]): boolean {
  if (/^(README(\.md)?|LICEN[CS]E(\..*)?|package\.json)$/i.test(path)) return true;
  return files
    .filter((entry) => !entry.startsWith("!"))
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/+$/, ""))
    .some((entry) => path === entry || path.startsWith(`${entry}/`));
}

test("P21: every relative README link points to a file the npm package ships", () => {
  const files = (JSON.parse(read("package.json")) as { files?: string[] }).files ?? [];
  const broken = relativeTargets(read("README.md")).filter((target) => !shipped(target, files));
  assert.deepEqual(
    broken,
    [],
    `README links to files the npm package doesn't ship (404 on npmjs.com); link them as ${GITHUB_BLOB}<path>`,
  );
});

test("P21: the link check itself", () => {
  const files = ["dist/src", "!dist/src/**/*.map", "DATA_LICENSE.md", "docs/"];
  assert.deepEqual(
    relativeTargets('[a](Usage.md) [b](./DATA_LICENSE.md#terms) [c](https://x.example/y.md) [d](#top) ![e](docs/i.png "t") [f](mailto:a@b)'),
    ["Usage.md", "DATA_LICENSE.md", "docs/i.png"],
  );
  for (const path of ["README.md", "LICENSE", "package.json", "DATA_LICENSE.md", "dist/src/index.js", "docs/i.png"]) {
    assert.ok(shipped(path, files), path);
  }
  for (const path of ["Usage.md", "dist/srcx", "dist/test/a.js", "skills/x/SKILL.md"]) {
    assert.ok(!shipped(path, files), path);
  }
});
