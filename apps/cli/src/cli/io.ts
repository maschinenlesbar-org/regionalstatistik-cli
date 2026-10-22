// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { RegionalstatistikClient, RegionalstatistikClientOptions } from "@maschinenlesbar.org/regionalstatistik-client/internal/client";
import { RegionalstatistikError, RegionalstatistikUsageError, cutForMessage } from "@maschinenlesbar.org/regionalstatistik-client/internal/errors";
import type { CredentialStore } from "./credentials.js";
import { createLogger, type Logger } from "./log.js";

/**
 * The `-o` file could not be written once the answer was in (a missing directory, a
 * directory, EACCES, a full disk, a file that appeared during the request): a runtime
 * failure (exit 1), logged as an ERROR of `regstat.output`, the area of the `-o` file.
 * The old file, if any, is left as it was.
 */
export class OutputError extends RegionalstatistikError {}

/**
 * The `-o` target is refused before any request: `--force` without `-o`, a directory, an
 * existing path (a dangling link too) without `--force`, or a file whose directory is missing
 * or not writable. A usage error (exit 2), logged as an ERROR of `regstat.output`, the area of
 * the `-o` file.
 */
export class OutputRefusedError extends RegionalstatistikUsageError {}

/**
 * What an `-o` path names: nothing, a directory, a stream (a character device such as
 * `/dev/null`, a FIFO, a socket, or a descriptor path such as `/dev/stdout` or `/dev/fd/63` from
 * `>(…)`), or anything else (a regular file, a link: a dangling one too).
 */
export type FileState = "absent" | "directory" | "stream" | "exists";

/** The message for an existing `-o` path without `--force`. */
export function refuseOverwrite(path: string): string {
  return `Refusing to overwrite existing file "${cutForMessage(path)}". Pass --force to overwrite, or choose a different --output path.`;
}

/** The message for an `-o` path that is a directory, which `--force` can't fix. */
export function isDirectoryMessage(path: string): string {
  return `"${cutForMessage(path)}" is a directory; give a file path to --output.`;
}

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist raw bytes to `path`. A stream (`/dev/null`, a FIFO, `/dev/stdout`) is written in
   * place, with no claim and no temporary file. A file is written atomically: the old file
   * stays as it was until the new one is complete. Without `overwrite` the file must not exist
   * yet (exclusive create): anything at `path` — a file, or a symlink, even a dangling one —
   * makes it throw an `EEXIST` error instead of writing through it. With `overwrite` a symlink
   * is written through, also a dangling one (the file it names is created). A failure leaves no
   * file behind.
   */
  writeFile(path: string, data: Buffer, overwrite: boolean): void;
  /** What is at `path` (a dangling symlink counts as existing; a link to a directory is a directory). */
  fileState(path: string): FileState;
  /**
   * Why the file `path` names (through any links, with `overwrite`) cannot be created where it
   * would go, or undefined: its directory is missing, not a directory, or not writable; or the
   * link chain loops. Checked before the request, so a typo in the path costs none. Optional:
   * deps without it (tests with no real file system) skip the check.
   */
  parentProblem?(path: string, overwrite: boolean): string | undefined;
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

/** What `stderrAfterStdout` needs of stdout: its backlog, and the events that end one. */
export interface StdoutBacklog {
  readonly writableLength: number;
  on(event: "drain" | "close" | "error", listener: () => void): unknown;
}

/** How often a held record checks whether stdout's backlog is gone (ms). */
const BACKLOG_POLL_MS = 10;

/**
 * A stderr writer that waits for stdout. With both streams on one pipe (`2>&1 |`) and a
 * slow reader, stdout's data is still queued in the process while a record is written
 * to stderr at once, so the record landed inside the JSON (at 64 KiB). Here a text is
 * held while `stdout.writableLength > 0` and written, in order, once the backlog is
 * gone: on stdout's `drain`, `close` or `error`, or at the latest when a short poll sees
 * it empty (`drain` only follows a write that returned false). The poll keeps the
 * process alive until then, so a held record is never lost at exit.
 */
export function stderrAfterStdout(stdout: StdoutBacklog, write: (text: string) => void): (text: string) => void {
  const held: string[] = [];
  let poll: ReturnType<typeof setInterval> | undefined;
  const flush = (): void => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    for (const text of held.splice(0)) write(text);
  };
  let listening = false;
  return (text) => {
    if (held.length === 0 && stdout.writableLength === 0) return write(text);
    held.push(text);
    if (!listening) {
      listening = true;
      for (const event of ["drain", "close", "error"] as const) stdout.on(event, flush);
    }
    poll ??= setInterval(() => {
      if (stdout.writableLength === 0) flush();
    }, BACKLOG_POLL_MS);
  };
}

const stderrLine = stderrAfterStdout(process.stdout, (text) => process.stderr.write(text + "\n"));

/** What `stdoutWriter` needs of stdout. */
interface Stdout {
  write(data: string | Buffer): unknown;
  emit(event: "error", err: Error): unknown;
  readonly fd?: number;
}

/**
 * A writer for stdout that never drops a byte silently. When stdout is a regular file
 * (`> out.json`), Node's stream wrote it with one `writeSync` and ignored a short count, so a
 * file-size limit or a full disk cut the output short with exit 0 and nothing on stderr. Here
 * the data is written with `writeAll`, and a failure (EFBIG, ENOSPC) is emitted as stdout's
 * `error`, which `handleOutputErrors` turns into an ERROR record of `regstat.output` and
 * exit 1. A pipe, a socket or a terminal goes through the stream as before (EPIPE stays quiet).
 * Text and a download (`outBinary`) alike.
 */
export function stdoutWriter(
  stdout: Stdout = process.stdout,
  write: (fd: number, data: Buffer) => void = writeAll,
): (data: string | Buffer) => void {
  let toFile: boolean | undefined;
  return (data) => {
    toFile ??= stdout.fd !== undefined && isRegularFile(stdout.fd);
    if (!toFile) {
      stdout.write(data);
      return;
    }
    try {
      write(stdout.fd as number, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    } catch (err) {
      stdout.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  };
}

function isRegularFile(fd: number): boolean {
  try {
    return fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

const stdoutData = stdoutWriter();

export const defaultIO: CliIO = {
  readSecret: (prompt) => readSecretFrom(process.stdin, process.stderr, prompt),
  out: (text) => stdoutData(text + "\n"),
  // A record never lands inside the data when both streams share a pipe.
  err: stderrLine,
  writeFile: writeFileAtomic,
  fileState: fileStateOf,
  parentProblem: parentProblemOf,
  outBinary: (data) => stdoutData(data),
};

/** A path that names an open descriptor: `/dev/stdout`, `/dev/stderr`, `/dev/fd/N`, `/proc/self/fd/N`. */
const DESCRIPTOR_PATH = /^\/dev\/(?:stdout|stderr|fd\/\d+)$|^\/proc\/self\/fd\/\d+$/;

/** The longest file name (in bytes) most file systems take (NAME_MAX). */
const NAME_MAX = 255;

/** `CliIO.fileState` on the real file system. */
function fileStateOf(path: string): FileState {
  // A descriptor path is the shell's redirection (`-o /dev/stdout`, `-o >(gzip > x.gz)`):
  // written in place even when it leads to a regular file, which the shell opened.
  if (DESCRIPTOR_PATH.test(path)) return "stream";
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) return "directory";
    return stats.isFIFO() || stats.isCharacterDevice() || stats.isSocket() ? "stream" : "exists";
  } catch {
    // statSync follows a link; a dangling one is still something an exclusive create
    // refuses (existsSync would call it absent, and -o would create a file wherever it
    // points), so lstat decides between "exists" and "absent".
    try {
      lstatSync(path);
      return "exists";
    } catch {
      return "absent";
    }
  }
}

/** `CliIO.parentProblem` on the real file system. */
function parentProblemOf(path: string, overwrite: boolean): string | undefined {
  let target: string;
  try {
    target = overwrite ? linkTarget(path) : path;
  } catch (err) {
    return `Cannot write to "${cutForMessage(path)}": ${reasonOf(err)}`;
  }
  const dir = dirname(target);
  try {
    if (!statSync(dir).isDirectory()) return `Cannot write to "${cutForMessage(path)}": "${cutForMessage(dir)}" is not a directory.`;
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `Cannot write to "${cutForMessage(path)}": the directory "${cutForMessage(dir)}" does not exist.`;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return `Cannot write to "${cutForMessage(path)}": no permission to create files in "${cutForMessage(dir)}".`;
    }
    return `Cannot write to "${cutForMessage(path)}": ${reasonOf(err)}`;
  }
  return undefined;
}

/**
 * Node's error text without its `, open '<path>'` tail, which named the hidden temporary file
 * (`ENAMETOOLONG: name too long, lstat '.x….json.123-0d1a.tmp'`) instead of the user's file.
 */
export function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/, \w+ '.*'$/s, "");
}

/**
 * `CliIO.writeFile` on the real file system. A stream (a device, a FIFO, a descriptor path) is
 * written in place: it can't be renamed over, and nothing in it can be lost. Without `overwrite`
 * the name is claimed first with an exclusive create ("wx" = O_CREAT|O_EXCL: it never follows a
 * symlink planted at `path` and closes the gap between the check before the request and the
 * write), which throws `EEXIST` for anything there. Then the data goes to a temporary file beside
 * the target, renamed over it when complete. A write cut short (a full disk, a quota) leaves the
 * old file as it was and no file under a new name, so the next run isn't refused for one that
 * holds half a result. With `overwrite` an existing file's mode is kept and a symlink is written
 * through to the file it points at, also when that file doesn't exist yet (the link stays).
 */
function writeFileAtomic(path: string, data: Buffer, overwrite: boolean): void {
  if (fileStateOf(path) === "stream") return writeInPlace(path, data);
  if (overwrite) return replaceFile(linkTarget(path), data);
  writeClaimed(path, data);
}

/** Paths to remove if a signal ends the run: the claim and the temporary file of a write under way. */
const pending = new Set<string>();

/** The exit codes of the signals that remove `pending` paths: 128 + the signal's number. */
const SIGNAL_EXITS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

let signalsHandled = false;

/**
 * From the first file write on, SIGINT, SIGTERM and SIGHUP remove the claim and the temporary
 * file of a write under way, then exit with 130, 143 or 129. Before, Node's default action
 * killed the process mid-write and left an empty claim (the next run refused it as an existing
 * file) and the whole temporary file. The write itself is synchronous, so a signal that arrives
 * during it is handled once it is done. Not installed for a stream: a handler restarts a blocked
 * `open()` of a FIFO without a reader, so Ctrl-C could not end the wait.
 */
function removeOnSignals(): void {
  if (signalsHandled) return;
  signalsHandled = true;
  for (const [signal, code] of Object.entries(SIGNAL_EXITS)) {
    process.once(signal, () => {
      for (const path of pending) rmSync(path, { force: true });
      pending.clear();
      process.exit(code);
    });
  }
}

/** Claim `path` (exclusive create), then replace the claim with `data`; the claim is removed on a failure. */
function writeClaimed(path: string, data: Buffer): void {
  removeOnSignals();
  closeSync(openSync(path, "wx"));
  pending.add(path);
  try {
    replaceFile(path, data);
  } catch (err) {
    // A write cut short (a full disk, a quota) leaves no file under the new name either, so
    // the next run isn't refused for a file that holds half a result.
    rmSync(path, { force: true });
    throw err;
  } finally {
    pending.delete(path);
  }
}

/**
 * Replace `target` with `data` atomically: a temporary file beside it, created exclusively,
 * renamed over it. An existing file's mode is kept.
 */
function replaceFile(target: string, data: Buffer): void {
  removeOnSignals();
  const temporary = join(dirname(target), temporaryName(basename(target)));
  pending.add(temporary);
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    const mode = modeOf(target);
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  } finally {
    pending.delete(temporary);
  }
}

/**
 * The temporary file's name for `base`: `.<base>.<pid>-<random>.tmp`, within NAME_MAX bytes. A
 * long base name is shortened (at a character boundary), the random part is kept, so a valid
 * name of up to 255 bytes can be written (`ENAMETOOLONG` named the hidden file before).
 */
function temporaryName(base: string): string {
  const suffix = `.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  const room = NAME_MAX - 1 - Buffer.byteLength(suffix);
  let kept = base;
  while (Buffer.byteLength(kept) > room) kept = kept.slice(0, kept.length - (/[\udc00-\udfff]$/.test(kept) ? 2 : 1));
  return `.${kept}${suffix}`;
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/** Most links followed for one `-o` path, as the kernel's ELOOP limit. */
const MAX_LINKS = 40;

/**
 * The file a path names, through any symlinks, so --force writes where a link points: also
 * when the link dangles, where the file it names is created. A loop throws (ELOOP).
 */
function linkTarget(path: string): string {
  let current = resolve(path);
  for (let hops = 0; hops <= MAX_LINKS; hops++) {
    let link: string;
    try {
      if (!lstatSync(current).isSymbolicLink()) return current;
      link = readlinkSync(current);
    } catch {
      return current; // nothing there (yet): this is the file to create
    }
    current = resolve(dirname(current), link);
  }
  throw Object.assign(new Error("too many levels of symbolic links"), { code: "ELOOP" });
}

/** Write `data` to a stream target (a device, a FIFO, a descriptor path) in place, every byte. */
function writeInPlace(path: string, data: Buffer): void {
  // Append: on a descriptor path that leads to a file (`-o /dev/stdout >> log`), the shell's
  // own mode stands; on a device or a FIFO it makes no difference.
  let fd: number;
  try {
    fd = openSync(path, "a");
  } catch (err) {
    // Linux can't open a socket through its descriptor path (ENXIO), and a process started
    // with socket stdio (Node's child_process, a service manager) has one: `-o /dev/stdout` is
    // then written to the descriptor the process already holds, which stays open.
    const own = descriptorOf(path);
    if ((err as NodeJS.ErrnoException).code !== "ENXIO" || own === undefined) throw err;
    return writeAll(own, data);
  }
  try {
    writeAll(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** The descriptor a descriptor path names (`/dev/stdout` 1, `/dev/fd/63` 63), else undefined. */
function descriptorOf(path: string): number | undefined {
  if (path === "/dev/stdout") return 1;
  if (path === "/dev/stderr") return 2;
  const n = /^\/(?:dev|proc\/self)\/fd\/(\d+)$/.exec(path)?.[1];
  return n === undefined ? undefined : Number(n);
}

/** A short pause for a non-blocking descriptor that is full (EAGAIN), without a busy loop. */
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write all of `data` to `fd`, or throw. `writeSync` may write less than asked (a file-size
 * limit, a full disk): the rest is written in a loop, and the call that cannot write throws
 * (EFBIG, ENOSPC). A descriptor the shell made non-blocking (a pipe through `/dev/fd/N`) answers
 * EAGAIN while the reader is behind: wait a moment and go on.
 */
function writeAll(fd: number, data: Buffer): void {
  for (let at = 0; at < data.length; ) {
    try {
      at += writeSync(fd, data, at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

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
