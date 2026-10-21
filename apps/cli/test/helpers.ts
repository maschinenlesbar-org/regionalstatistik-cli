// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/regionalstatistik-client/internal/http";
import type { CliDeps } from "../src/cli/io.js";
import { defaultDeps } from "../src/cli/program.js";
import { run } from "../src/cli/run.js";
import { bodyOf, jsonResponse, makeMockTransport } from "@maschinenlesbar.org/regionalstatistik-client/test/helpers";

export * from "@maschinenlesbar.org/regionalstatistik-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [regstat.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

// ---- CLI <-> library parity ---------------------------------------------------

/** What one side of a parity run did: its outcome and the requests it sent. */
export interface ParitySide {
  /** Requests this side sent, in order. */
  requests: HttpRequest[];
}

export interface CliOutcome extends ParitySide {
  code: number;
  out: string;
  err: string;
}

/**
 * What the library call did: its value or its error. The shape is the kit's, which the
 * shared conformance bodies (P24, P25) read (`error?.name`).
 */
export interface LibOutcome extends ParitySide {
  ok: boolean;
  value?: unknown;
  /** What the call threw; anything but an Error is wrapped in one. */
  error?: Error;
}

export interface ParityResult {
  cli: CliOutcome;
  lib: LibOutcome;
}

export interface ParityInput {
  /** argv for run() (without the `node regstat` prefix). */
  argv: string[];
  /** The library call, on a transport shared with the CLI run. */
  lib: (transport: Transport) => unknown;
  /** The CLI's environment (default: empty, so no real credentials leak in). */
  env?: Record<string, string | undefined>;
  /** Answers every request on both sides (default: an empty JSON object). */
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
}

/**
 * Send one input through the CLI (`run()`, its client built by the real
 * `createClient` on a recording mock transport) and through a library call on
 * that same transport, and return both outcomes with the requests each side
 * sent. A parity test then asserts the same outcome: both reject and neither
 * sends a request, or both send the identical request (see `requestKey`).
 */
export async function parity(input: ParityInput): Promise<ParityResult>;
/** The kit's form, as the shared conformance bodies (P24, P25) call it. */
export async function parity(
  argv: string[],
  lib: (transport: Transport) => unknown,
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): Promise<ParityResult>;
export async function parity(
  first: ParityInput | string[],
  call?: (transport: Transport) => unknown,
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): Promise<ParityResult> {
  const input: ParityInput = Array.isArray(first)
    ? { argv: first, lib: call ?? (() => undefined), ...(responder !== undefined ? { responder } : {}) }
    : first;
  const mt = makeMockTransport(input.responder ?? (() => jsonResponse({})));
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => files.set(p, d),
      fileState: (p) => (files.has(p) ? "exists" : "absent"),
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => defaultDeps.createClient({ ...opts, transport: mt.transport }),
    env: input.env ?? {},
  };
  const code = await run(input.argv, deps);
  const cliRequests = mt.calls.splice(0);

  let lib: LibOutcome;
  try {
    const value = await input.lib(mt.transport);
    lib = { ok: true, value, requests: mt.calls.splice(0) };
  } catch (error) {
    lib = { ok: false, error: error instanceof Error ? error : new Error(String(error)), requests: mt.calls.splice(0) };
  }
  return { cli: { code, out: out.join("\n"), err: untimed(err.join("\n")), requests: cliRequests }, lib };
}

/**
 * A comparable summary of a request: method, URL, the form body as sorted
 * key=value pairs (the CLI and the library may add parameters in a different
 * order) and the credential headers.
 */
export function requestKey(req: HttpRequest): string {
  const body = [...bodyOf(req).entries()].map(([k, v]) => `${k}=${v}`).sort();
  const creds = ["username", "password"].map((h) => `${h}:${req.headers?.[h] ?? "-"}`);
  return `${req.method} ${req.url} [${body.join("&")}] ${creds.join(" ")}`;
}
