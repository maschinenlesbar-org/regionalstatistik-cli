#!/usr/bin/env node
// Bin shim: parse argv, run the CLI, and set the process exit code. All real
// logic lives in run.ts (testable without spawning a subprocess).

import { exitOnSignalsAsPid1, handleOutputErrors } from "./io.js";
import { installWarningLog } from "./log.js";
import { processLogger, run } from "./run.js";

const argv = process.argv.slice(2);
// In a container the CLI is PID 1, which ignores a signal nothing listens for.
exitOnSignalsAsPid1();
// What happens outside run() is logged too, in the format argv asks for.
const log = processLogger(argv);
installWarningLog(process, log);
handleOutputErrors(process, undefined, log);

run(argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
