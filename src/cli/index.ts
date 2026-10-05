#!/usr/bin/env node
// Bin shim: parse argv, run the CLI, and set the process exit code. All real
// logic lives in run.ts (testable without spawning a subprocess).

import { handleOutputErrors } from "./io.js";
import { run } from "./run.js";

handleOutputErrors();

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
