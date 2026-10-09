// Credentials kept in a file of their own: `regstat config set token` (or
// `username` and `password`).
//
// The GENESIS login could only come from `--token` / `--username` / `--password`,
// which put it into shell history and `ps`, or from `REGIONALSTATISTIK_API_TOKEN` /
// `REGIONALSTATISTIK_USERNAME` / `REGIONALSTATISTIK_PASSWORD`, which every shell, cron
// job and launcher has to export — people end up writing it into wrapper scripts. It
// now has a home of its own:
//
//   $XDG_CONFIG_HOME/regionalstatistik/credentials   (else ~/.config/regionalstatistik/credentials)
//
// one JSON object of name → value, mode 0600 in a directory of mode 0700, replaced
// atomically. An OS keychain is not used (yet): on servers, under cron, systemd and in
// containers it is usually locked or missing, and this file is what such a setup
// would fall back to anyway. The same mechanism as openka-cli's `ka config` and
// dip-bundestag-cli's `dip config`.

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { RegionalstatistikError, RegionalstatistikUsageError } from "../client/errors.js";

/** The directory under `$XDG_CONFIG_HOME` (or `~/.config`) this program keeps its credentials in. */
export const CONFIG_DIR_NAME = "regionalstatistik";

/** A credential's name: lower-case words joined by hyphens, like `token`. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Why `name` cannot name a credential, or undefined. */
export function credentialNameProblem(name: string): string | undefined {
  return NAME.test(name) ? undefined : "Not a credential name: expected lower-case words joined by hyphens, like token.";
}

/**
 * Why `value` cannot be stored as a credential, or undefined: blank, or holding a
 * control character — a stray line break from a paste would be sent as part of a
 * header. A tab and spaces inside are allowed: a GENESIS password may hold them, and
 * an HTTP header carries them (the library's `credentialProblem` has the last word
 * on what a token, username or password may be).
 */
export function credentialValueProblem(value: string): string | undefined {
  if (value.trim() === "") return "The value is empty.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || (c >= 0x7f && c <= 0x9f)) {
      return "The value holds a control character (a line break, perhaps).";
    }
  }
  return undefined;
}

/**
 * Where the credentials file is: `$XDG_CONFIG_HOME/regionalstatistik/credentials`, else
 * `$HOME/.config/regionalstatistik/credentials` — `HOME` from `env` first, so a caller's
 * environment decides, and only then the system's home directory.
 */
export function resolveCredentialsPath(env: Record<string, string | undefined>): string {
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.trim() !== "" && isAbsolute(xdg)) return join(xdg, CONFIG_DIR_NAME, "credentials");
  const home = env["HOME"] !== undefined && env["HOME"].trim() !== "" ? env["HOME"] : homedir();
  return join(home, ".config", CONFIG_DIR_NAME, "credentials");
}

/** Below this length a value shows nothing of itself: eight of twelve characters is most of it. */
const MASK_MIN_LENGTH = 20;

/** True for a credential name whose value is a password: never partly shown. */
function isPasswordName(name: string | undefined): boolean {
  return name !== undefined && /(^|-)password$/.test(name);
}

/**
 * `abcd…wxyz`: enough to tell two values apart, never enough to use one. A value shorter
 * than 20 characters, and a password whatever its length, shows nothing of itself, not
 * even its length: `****`.
 */
export function maskCredential(value: string, name?: string): string {
  return !isPasswordName(name) && value.length >= MASK_MIN_LENGTH ? `${value.slice(0, 4)}…${value.slice(-4)}` : "****";
}

/** How long `set`/`unset` wait for another writer's lock before giving up (ms). */
export const LOCK_WAIT_MS = 2_000;
/** A lock older than this (ms) is left over from a crash and taken over. */
export const LOCK_STALE_MS = 30_000;
/** The wait between two attempts at the lock (ms). */
const LOCK_RETRY_MS = 50;

/** The clock and the (synchronous) wait of the lock, injectable for tests. */
export interface CredentialStoreOptions {
  /** Milliseconds since the epoch. Unset, `Date.now`. */
  now?: () => number;
  /** Block for `ms` milliseconds. Unset, a real wait. */
  sleep?: (ms: number) => void;
}

/** A synchronous wait: `set`/`unset` stay synchronous, and the wait is short. */
function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The credentials file. Reading it checks what ssh checks of a private key: a regular
 * file, owned by this user, readable by nobody else — anything else is a
 * `RegionalstatistikError` naming the fix, rather than a login quietly used from a
 * file others can read.
 */
export class CredentialStore {
  readonly path: string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => void;

  constructor(path: string, options: CredentialStoreOptions = {}) {
    this.path = resolve(path);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? blockFor;
  }

  /** The store at `resolveCredentialsPath(env)`. */
  static fromEnv(env: Record<string, string | undefined>): CredentialStore {
    return new CredentialStore(resolveCredentialsPath(env));
  }

  get(name: string): string | undefined {
    return this.read()[name];
  }

  /** Every stored name, sorted. */
  names(): string[] {
    return Object.keys(this.read()).sort();
  }

  /** Every stored name → value, read once. */
  all(): Record<string, string> {
    return this.read();
  }

  set(name: string, value: string): void {
    const nameReason = credentialNameProblem(name);
    if (nameReason !== undefined) throw new RegionalstatistikUsageError(nameReason);
    const valueReason = credentialValueProblem(value);
    if (valueReason !== undefined) throw new RegionalstatistikUsageError(valueReason);
    this.locked(() => this.write({ ...this.read(), [name]: value }));
  }

  /** Remove `name`; false when it was not stored. The file goes when nothing is left in it. */
  unset(name: string): boolean {
    // Nothing to remove: no lock, and no directory created for it.
    if (!(name in this.read())) return false;
    return this.locked(() => {
      const all = this.read();
      if (!(name in all)) return false;
      delete all[name];
      if (Object.keys(all).length === 0) {
        try {
          rmSync(this.path, { force: true });
        } catch (err) {
          throw this.writeError(err);
        }
        return true;
      }
      this.write(all);
      return true;
    });
  }

  /**
   * Run `fn` (a read-modify-write) holding `credentials.lock` beside the file, so two
   * `config set` at the same time (a username and a password, set in parallel) cannot
   * both log "Stored" while one value is lost. The lock is created exclusively; a held
   * one is retried for `LOCK_WAIT_MS`, then the call fails ("Another regstat config is
   * writing …; try again") and nothing is changed. A lock older than `LOCK_STALE_MS` was
   * left by a crash and is taken over.
   */
  private locked<T>(fn: () => T): T {
    const lock = `${this.path}.lock`;
    try {
      // Inside the try: an unwritable config location is named like any write failure.
      this.ensureDirectory();
    } catch (err) {
      throw this.writeError(err);
    }
    const start = this.#now();
    for (;;) {
      try {
        writeFileSync(lock, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
        break;
      } catch (err) {
        if ((err as { code?: unknown }).code !== "EEXIST") throw this.writeError(err);
      }
      let age: number | undefined;
      try {
        age = this.#now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released in the meantime: try again at once
      }
      if (age > LOCK_STALE_MS) {
        rmSync(lock, { force: true });
        continue;
      }
      if (this.#now() - start >= LOCK_WAIT_MS) {
        throw new RegionalstatistikError(`Another regstat config is writing ${this.path}; try again.`);
      }
      this.#sleep(LOCK_RETRY_MS);
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  /** The file's directory, created with mode 0700, and tightened to it when others could read it. */
  private ensureDirectory(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }

  private read(): Record<string, string> {
    // lstat, not exists: a link — dangling or not — is refused, not taken for "no file".
    let stats;
    try {
      stats = lstatSync(this.path);
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return {};
      throw new RegionalstatistikError(
        `Could not read the credentials file ${this.path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (!stats.isFile()) throw new RegionalstatistikError(`${this.path} is not a regular file; it cannot be the credentials file.`);
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
        throw new RegionalstatistikError(`The credentials file ${this.path} belongs to another user; it is not read.`);
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new RegionalstatistikError(
          `The credentials file ${this.path} can be read by others (mode ${(stats.mode & 0o777).toString(8)}); ` +
            `it is not used until only you can: chmod 600 ${this.path}`,
        );
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (err) {
      throw new RegionalstatistikError(
        `The credentials file ${this.path} is not valid JSON; fix it, or remove it and set the values again.`,
        { cause: err },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) {
      throw new RegionalstatistikError(`The credentials file ${this.path} is not an object of names and strings.`);
    }
    return { ...(parsed as Record<string, string>) };
  }

  /**
   * Replace the file atomically: a temporary file beside it, created with mode 0600
   * and exclusively, renamed over it. A crash leaves the old file or the new one,
   * never half of either, and at no moment is the login in a file others can read.
   */
  private write(all: Record<string, string>): void {
    const temporary = `${this.path}.tmp-${process.pid}`;
    const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    try {
      // Inside the try: an unwritable config location (EACCES on mkdir or chmod) is
      // reported like any other write failure, naming the file.
      this.ensureDirectory();
      // Left by a run of the same pid that crashed between the two steps.
      rmSync(temporary, { force: true });
      writeFileSync(temporary, JSON.stringify(sorted, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } catch (err) {
      rmSync(temporary, { force: true });
      throw this.writeError(err);
    }
  }

  /** "Could not write the credentials file <path>: <reason>", the cause kept. */
  private writeError(err: unknown): RegionalstatistikError {
    return new RegionalstatistikError(`Could not write the credentials file ${this.path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
