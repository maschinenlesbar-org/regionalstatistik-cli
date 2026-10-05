// P3 (fix plan 2026-10-06), the GENESIS part: GENESIS credentials are custom headers
// (`username`, `password`), which fetch forwards across origins when it follows a redirect.
// The engine follows none: it tells every transport `redirect: "manual"`, and rejects a
// response that a transport reports from another origin. A pair of local servers, A
// redirecting to B, shows what B receives.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { RegionalstatistikClient } from "../src/client/client.js";
import { RegionalstatistikApiError, RegionalstatistikNetworkError } from "../src/client/errors.js";
import type { HttpRequest, HttpResponse, Transport } from "../src/client/http.js";

const PW = "s3cret-Test-Pw";
const okBody = JSON.stringify({ Status: { Code: 0, Content: "ok", Type: "Information" }, List: [{ Code: "from B" }] });

interface Pair {
  a: string;
  b: string;
  /** Headers of every request B received. */
  bSaw: http.IncomingHttpHeaders[];
  close(): void;
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function pair(status = 307): Promise<Pair> {
  const bSaw: http.IncomingHttpHeaders[] = [];
  const b = await listen((req, res) => {
    bSaw.push(req.headers);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(okBody);
  });
  const a = await listen((req, res) => {
    req.resume();
    res.writeHead(status, { location: `${b.base}${req.url ?? "/"}` });
    res.end();
  });
  return {
    a: a.base,
    b: b.base,
    bSaw,
    close: () => {
      a.server.close();
      b.server.close();
    },
  };
}

/** A fetch transport as the docs ask for it: passes `redirect` (and the deadline) on. */
const manualFetch: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
  const r = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
    ...(req.redirect !== undefined ? { redirect: req.redirect } : {}),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  });
  return { status: r.status, headers: r.headers as unknown as HttpResponse["headers"], body: Buffer.from(await r.arrayBuffer()), url: r.url };
};

/** A fetch transport as most examples write it: follows redirects, but reports the final URL. */
const followingFetch: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
  const r = await fetch(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) });
  return { status: r.status, headers: r.headers as unknown as HttpResponse["headers"], body: Buffer.from(await r.arrayBuffer()), url: r.url };
};

const clients = (base: string, transport?: Transport) => [
  new RegionalstatistikClient({ baseUrl: base, username: "testuser01", password: PW, maxRetries: 0, ...(transport ? { transport } : {}) }),
  new RegionalstatistikClient({ baseUrl: base, token: "0123456789abcdef0123456789abcdef", maxRetries: 0, ...(transport ? { transport } : {}) }),
];

test("P3: every request tells the transport not to follow redirects", async () => {
  const seen: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(okBody) };
  };
  const c = new RegionalstatistikClient({ username: "testuser01", password: PW, transport });
  await c.catalogue.tables();
  await c.find({ term: "x" });
  await c.whoami().catch(() => undefined);
  assert.ok(seen.length >= 3);
  for (const req of seen) assert.equal(req.redirect, "manual");
});

test("P3: a cross-origin redirect sends nothing to the other host (default and a manual fetch transport)", async () => {
  for (const status of [301, 302, 307, 308]) {
    const p = await pair(status);
    try {
      for (const transport of [undefined, manualFetch]) {
        for (const client of clients(p.a, transport)) {
          await assert.rejects(client.catalogue.tables(), (e: unknown) => e instanceof RegionalstatistikApiError && /redirect/.test(e.message));
        }
      }
      assert.equal(p.bSaw.length, 0, `${status}: B received ${JSON.stringify(p.bSaw)}`);
    } finally {
      p.close();
    }
  }
});

test("P3: a transport that followed a redirect to another origin is rejected, not believed", async () => {
  const p = await pair(307);
  try {
    for (const client of clients(p.a, followingFetch)) {
      await assert.rejects(client.catalogue.tables(), (e: unknown) => {
        assert.ok(e instanceof RegionalstatistikNetworkError, String(e));
        assert.match(e.message, /followed a redirect to another origin/);
        assert.ok(!e.message.includes(PW));
        return true;
      });
    }
  } finally {
    p.close();
  }
});

test("P3: a response reported from the request's own origin is accepted", async () => {
  const transport: Transport = async (req) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(okBody),
    url: req.url,
  });
  const result = await new RegionalstatistikClient({ username: "testuser01", password: PW, transport }).catalogue.tables();
  assert.equal((result as unknown as { List: Array<{ Code: string }> }).List[0]!.Code, "from B");
});
