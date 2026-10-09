// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { lstatSync, writeFileSync } from "node:fs";
import type { RegionalstatistikClient, RegionalstatistikClientOptions } from "../client/client.js";
import { RegionalstatistikError, RegionalstatistikUsageError } from "../client/errors.js";
import type { CredentialStore } from "./credentials.js";
import { createLogger, type Logger } from "./log.js";

/**
 * The `-o` file could not be written once the answer was in (a missing directory, a
 * directory, EACCES, …): a runtime failure as before (exit 1), logged as an ERROR of
 * `regstat.output`, the area of the `-o` file.
 */
export class OutputError extends RegionalstatistikError {}

/**
 * The `-o` file exists and `--force` is not given: a usage error as before (exit 2),
 * logged as an ERROR of `regstat.output`, the area of the `-o` file.
 */
export class OutputRefusedError extends RegionalstatistikUsageError {}

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
  /**
   * stdout without the run's redaction, for the one value the user asked for in full:
   * `regstat config get --reveal`. Set by `run()` (`withRedactedOutput`); unset, `out`
   * is used.
   */
  outRaw?(text: string): void;
  /**
   * Read a secret for `regstat config set`: typed at a prompt without echo, or piped
   * in. Optional: without it, `config set` refuses rather than reading the command line.
   */
  readSecret?(prompt: string): Promise<string>;
  /**
   * Keep these values out of everything printed from here on, like the secrets of
   * the command line and the environment (`run()` sets it; `action()` calls it for a
   * login read from the credentials file, and `config get` and `config set` for the
   * value they read).
   */
  redact?(secrets: readonly string[]): void;
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
  /**
   * The credentials file (`regstat config`), consulted for the login when neither a
   * flag nor an environment variable gives any credential. Optional: deps without it —
   * every test that does not ask for it — never read a credentials file, the user's
   * least of all.
   */
  credentials?: () => CredentialStore;
  /**
   * Where diagnostics go: one record per line on stderr, in the `--log-format`
   * (`log.ts`). `run()` sets it from argv; deps without it log text through `io.err`.
   */
  log?: Logger;
  /** The clock the log's timestamps come from. Unset, the real one. */
  now?: () => Date;
}

/** The deps' logger, or one that writes text records through `io.err`. */
export function logOf(deps: CliDeps): Logger {
  return deps.log ?? createLogger({ format: "text", write: (line) => deps.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) });
}

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on">;
}

/**
 * Handle write errors on stdout/stderr, which Node otherwise reports as an
 * unhandled 'error' event: a raw stack trace and exit 1.
 *
 * A reader that stops early — `| head`, `| jq` exiting on the first match, a closed
 * pager — closes the pipe while the CLI is still writing, and the next write fails
 * with EPIPE (ENOTCONN when stdout is a socket whose peer has gone, as when a Node
 * parent spawns the CLI with piped stdio on macOS). That is ordinary use, so the
 * process exits 0 at once, quietly. Any
 * other stdout error is an ERROR record of `regstat.output` (`Could not write to
 * stdout: <message>`, through `log`, in the run's format) and exits 1. On stderr an
 * EPIPE (or ENOTCONN) is ignored, so a failed run keeps its exit code; any other stderr
 * error exits 1 silently (there is nowhere left to report it).
 * The bin shim installs this once, before `run()`, with a logger for the format argv
 * asks for (`processLogger`).
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Pick<Logger, "error"> = createLogger({ format: "text", write: (line) => process.stderr.write(line + "\n") }),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    log.error("output", `Could not write to stdout: ${err.message}`);
    exit(1);
  });
  // stderr's reader going away doesn't make a failed run a success: ignore EPIPE/ENOTCONN there
  // and let the run's own exit code stand (`2>&1 | true` must not turn a usage error into 0).
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

export const defaultIO: CliIO = {
  readSecret: (prompt) => readSecretFrom(process.stdin, process.stderr, prompt),
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

/**
 * The longest secret `readSecretFrom` takes (64 KiB). Reading stops beyond it, so an
 * endless input (`< /dev/zero`) cannot grow memory without bound, and a value that
 * could never be sent as a header is not stored.
 */
export const MAX_SECRET_BYTES = 64 * 1024;

/**
 * True when `rest`, what followed a line break `brk` in the same read, holds more than
 * the LF of a CR LF and escape sequences (a bracketed-paste end marker).
 */
function moreAfterLineBreak(rest: string, brk: string): boolean {
  const tail = brk === "\r" && rest.startsWith("\n") ? rest.slice(1) : rest;
  // Built from char codes, so the source stays free of control bytes.
  const esc = String.fromCharCode(0x1b);
  const sequences = new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]|${esc}O.|${esc}`, "g");
  return tail.replace(sequences, "") !== "";
}

/** The refusal of a secret longer than `MAX_SECRET_BYTES`. */
function secretTooLong(): RegionalstatistikUsageError {
  return new RegionalstatistikUsageError("The value is longer than 64 KiB; nothing was stored.");
}

/**
 * `CliIO.readSecret` over real streams. From a pipe or a file (`< token.txt`,
 * `printf %s "$TOKEN" | regstat config set token`) the whole input, one trailing
 * newline dropped. On a terminal the input is read in raw mode, so nothing is echoed:
 * Enter ends it, Backspace takes a character back, Ctrl-C stops (nothing stored) and
 * Ctrl-D ends it like Enter. Escape sequences (arrow keys, bracketed-paste markers) are
 * dropped; any other character is kept, so `config set` refuses what it would refuse
 * from a pipe; a paste with more after its first line break is refused. Either way a
 * value longer than `MAX_SECRET_BYTES` is refused (`RegionalstatistikUsageError`), and reading
 * stops there.
 */
export async function readSecretFrom(
  stdin: NodeJS.ReadStream | NodeJS.ReadableStream,
  stderr: Pick<NodeJS.WriteStream, "write">,
  prompt: string,
): Promise<string> {
  const tty = stdin as NodeJS.ReadStream;
  if (tty.isTTY !== true || typeof tty.setRawMode !== "function") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      bytes += buffer.length;
      // Room for the line break that is dropped below; leaving the loop destroys the stream.
      if (bytes > MAX_SECRET_BYTES + 2) throw secretTooLong();
    }
    const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw secretTooLong();
    return value;
  }
  stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    // Where an escape sequence stands, across reads: after ESC, inside a CSI (`ESC [`
    // parameters… final, bracketed-paste markers included), before SS3's final (`ESC O x`).
    let escape: "none" | "esc" | "csi" | "ss3" = "none";
    const finish = (error?: Error): void => {
      tty.removeListener("data", onData);
      tty.setRawMode(false);
      tty.pause();
      stderr.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const chars = [...chunk.toString()];
      for (const [i, ch] of chars.entries()) {
        // An arrow key or a paste marker is a keystroke, not part of the value.
        if (escape === "csi") {
          if (ch >= "@" && ch <= "~") escape = "none";
          continue;
        }
        if (escape === "ss3") {
          escape = "none";
          continue;
        }
        if (escape === "esc") {
          escape = ch === "[" ? "csi" : ch === "O" ? "ss3" : "none";
          if (escape !== "none") continue;
        }
        if (ch === "\u001b") {
          escape = "esc";
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          // A paste with more after its first line break: storing the first line alone
          // would keep a value the user did not mean, and leave the rest to the shell.
          if (moreAfterLineBreak(chars.slice(i + 1).join(""), ch)) {
            return finish(new RegionalstatistikUsageError("The value holds a line break; nothing was stored."));
          }
          return finish();
        }
        if (ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new RegionalstatistikError("Interrupted; nothing was stored."));
        if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
        // Any other character is kept, a tab (a password may hold one) or a control
        // character included, so the value is refused as the same input from a pipe is,
        // not silently changed.
        else value += ch;
        if (value.length > MAX_SECRET_BYTES) return finish(secretTooLong());
      }
    };
    tty.setRawMode(true);
    tty.resume();
    tty.on("data", onData);
  });
}
