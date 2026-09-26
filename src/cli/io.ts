// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { lstatSync, writeFileSync } from "node:fs";
import type { RegionalstatistikClient, RegionalstatistikClientOptions } from "../client/client.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist raw bytes to a file. Without `overwrite` the file must not exist yet
   * (exclusive create): anything at `path` — a file, or a symlink, even a dangling
   * one — makes it throw an `EEXIST` error instead of writing through it.
   */
  writeFile(path: string, data: Buffer, overwrite: boolean): void;
  /** True if a filesystem entry already exists at `path` (a dangling symlink counts). */
  fileExists(path: string): boolean;
  /** Write raw bytes to stdout (binary-safe). */
  outBinary(data: Buffer): void;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: RegionalstatistikClientOptions): RegionalstatistikClient;
  /**
   * Environment lookup, injected so the env-driven config
   * (REGIONALSTATISTIK_API_TOKEN / REGIONALSTATISTIK_USERNAME /
   * REGIONALSTATISTIK_PASSWORD) is testable without mutating process.env.
   * Defaults to process.env.
   */
  env?: Record<string, string | undefined>;
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  // "wx" = O_CREAT|O_EXCL: never follows a symlink planted at `path` and closes the
  // gap between the fileExists check and the write.
  writeFile: (path, data, overwrite) => writeFileSync(path, data, { flag: overwrite ? "w" : "wx" }),
  // lstat, not existsSync: existsSync follows a symlink and reports a dangling one
  // as absent, so -o would create a file wherever the link points.
  fileExists: (path) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  },
  outBinary: (data) => process.stdout.write(data),
};
