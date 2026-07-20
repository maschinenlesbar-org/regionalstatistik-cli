// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { existsSync, writeFileSync } from "node:fs";
import type { RegionalstatistikClient, RegionalstatistikClientOptions } from "../client/client.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Persist raw bytes to a file. */
  writeFile(path: string, data: Buffer): void;
  /** True if a filesystem entry already exists at `path`. */
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
  writeFile: (path, data) => writeFileSync(path, data),
  fileExists: (path) => existsSync(path),
  outBinary: (data) => process.stdout.write(data),
};
