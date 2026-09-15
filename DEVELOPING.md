# Developing `regionalstatistik-cli`

This repo follows the shared `*-cli` two-layer blueprint (a typed,
dependency-free client + a commander CLI, both driven through injectable seams)
and is a **near-clone of
[`destatis-genesis-cli`](https://github.com/maschinenlesbar-org/destatis-genesis-cli)** —
the Regionaldatenbank Deutschland runs the very same GENESIS webservice software
(GENESIS V5.0.4 as of 2026). This document records what is **specific** to the
regionalstatistik.de installation and every deliberate divergence from the
destatis reference. Read it alongside [GLOSSARY.md](GLOSSARY.md).

## Layout

```
src/
  client/        # typed API client, usable as a library independent of the CLI
    types.ts     # GENESIS envelope + catalogue/find list items (opaque data/metadata Objects)
    params.ts    # per-endpoint parameter interfaces (regionalvariable/regionalkey!)
    query.ts     # dependency-free query-string builder
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building, retry, Status.Code logical-error mapping, URL redaction
    errors.ts    # Regionalstatistik{Error,ApiError,NetworkError,UsageError,ParseError}
    client.ts    # RegionalstatistikClient — helloworld/find + catalogue/metadata/data groups
    index.ts
  cli/
    io.ts        # injectable I/O + env seam (CliDeps / CliIO)
    shared.ts    # option parsers, credential resolution, option->client mapping, render
    commands/    # hello, find, catalogue, metadata, data
    program.ts   # assembles the commander program; seeds credential flags from env
    run.ts       # argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
  index.ts       # library entry
```

Two seams keep everything testable in-process: **`Transport`** (the only HTTP
seam; tests inject a mock) and **`CliDeps`** (client factory + I/O + `env`).
`run.ts` returns an exit code rather than calling `process.exit`.

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck
npm test            # pretest builds, then node --test dist/test/*.test.js
npm start -- --help # run the built CLI
```

## Host-specific facts (verified live 2026-07-13)

### 1. The API path is lowercase: `/genesisws/rest/2020`

Unlike DESTATIS' `/genesisWS/rest/2020`, **the uppercase path 404s on this
host** (with an HTML error page, served with a leading UTF-8 BOM). The path
constant in `client.ts` must stay exactly `/genesisws/rest/2020`. The technical
descriptions live at `https://www.regionalstatistik.de/genesisws/rest/2020/application.wadl`
(WADL) and `https://www.regionalstatistik.de/genesisws/swagger-ui` (Swagger UI).

### 2. Auth is POST with credentials in HTTP header fields

Same regime as destatis-genesis-cli, preserved 1:1:

- every authenticated call is a **`POST`** with an
  `application/x-www-form-urlencoded; charset=UTF-8` **body** carrying the
  parameters (`buildQueryString` doubles as the form encoder) — the charset is
  required or umlauts arrive mojibaked;
- credentials travel in **header fields**: `username` (an API token *or* the
  account username) and, only in username/password mode, `password`. There is
  **no** `Authorization`/`X-API-Key` header;
- **`Content-Length` is always set** (even `0`) — GENESIS answers `411`
  otherwise;
- a **GET to an authenticated endpoint answers HTTP 405** — this host is
  POST-only for everything except `helloworld/whoami` (an unauthenticated GET;
  the live reply carries only `User-Agent`, no `User-IP`). The GENESIS software
  line is dropping SOAP/GET entirely (destatis timeline: November 2025; the
  regionalstatistik Webservice page announces the SOAP shutdown as well).

**Registration is mandatory (since May 2025) and free**:
https://www.regionalstatistik.de/genesis/online. The CLI resolves credentials
with precedence **flag > env > unset** (`--username`/`--password` seeded from
`REGIONALSTATISTIK_USERNAME`/`REGIONALSTATISTIK_PASSWORD`, `--token` from
`REGIONALSTATISTIK_API_TOKEN`, in `program.ts`; validated in
`shared.ts:resolveCredentials`). A token wins over username/password; supplying
only one of username/password is a `RegionalstatistikUsageError` (exit 2). No
credential is ever bundled.

**Redirects are NOT followed.** Following a cross-origin redirect would forward
the credential headers to another origin; a 3xx surfaces as an error hinting at
the canonical host (`https://www.regionalstatistik.de`).
`engine.ts:redactUrl` additionally scrubs any `username`/`password` that a
caller managed to put in a URL (defensive — this client keeps them in headers).

### 3. HTTP 200 does not mean success — and auth errors are not enveloped

GENESIS answers HTTP 200 for most *logical* errors and carries the real outcome
in a `Status` object (`{ Code, Content, Type }`). After a successful parse,
`engine.ts:checkLogicalStatus` inspects it:

| `Status.Code` | Handling |
|---|---|
| `0`, `22` (auto-corrected), `50` (no newer data) | success — returned as-is (the envelope's `Status.Content` carries any warning) |
| `104` | **empty result** — returned as a valid empty list, NOT an error |
| `90` | object not found → `RegionalstatistikApiError`, `isNotFound` (exit 4) |
| `98` | too large → `RegionalstatistikApiError` with narrowing guidance (exit 1) |
| any `Type` = `Fehler`/`Error` | → `RegionalstatistikApiError` (exit 1) |

**Divergence from the destatis reference (its engine misses this):**
authentication failures arrive as a **flat, envelope-less**
`{ "Code": …, "Content": …, "Type": "ERROR" }` JSON body, paired with a
misleading HTTP status (verified live on both hosts):

| Reply | Meaning | This CLI |
|---|---|---|
| HTTP **401** + flat `Code 15` ("Sie sind nicht berechtigt …") | no/unrecognized credentials | exit 1 + credentials hint (`isAuthError`) |
| HTTP **404** + flat `Code 2` ("… prüfen … Nutzernamen bzw. das Passwort") | wrong credentials | exit **1** (NOT 4 — see below) |

`engine.ts` therefore extracts a GENESIS status from non-2xx bodies too
(`toApiError`), *and* maps the flat shape on 2xx replies defensively
(`checkLogicalStatus`). `RegionalstatistikApiError.isNotFound` only treats an
HTTP 404 as "object not found" when the body carried **no** GENESIS code —
otherwise the 404-for-bad-credentials would masquerade as a missing object and
exit 4. destatis-genesis-cli exits 4 in that case; this repo deliberately does
not. Key off the numeric `Code`, never the German/English `Type` text alone.

### 4. `data/*` payloads are opaque — and regional

`data/table` (and cube/timeseries/result) return the whole table as a
`";"`-delimited **CSV string** inside `Object.Content` (German number format).
The client keeps `Object` opaque (`DataObject { Content?: string }`) — CSV
parsing is intentionally out of scope; render the envelope as JSON or download a
file. `metadata/*` `Object` shapes vary per method and are likewise `JsonObject`.

What makes this database worth wrapping is the **regional dimension**:
`regionalvariable` (CLI `--region-var`) picks the regional level (e.g. `KREISE`,
`GEMEIN`) and `regionalkey` (CLI `--region-key`) selects regions by their
official AGS/ARS key, `*` wildcard allowed (`08*` = all of Baden-Württemberg's
Kreise). Table codes themselves encode the depth in their trailing digit
(`12411-01-01-4` = Kreise, see GLOSSARY.md). Gemeinde-level tables are large —
filter with `--region-key` or the too-large error (98) is quick to hit.

### 5. The async batch-job flow is NOT implemented (v1)

Large results come back with `Status.Code 98`. The full flow (re-issue with
`job=true`, poll `catalogue/results`, download `data/resultfile`) requires
username+password and a write op to clean up (`profile/removeresult`), so it is
deliberately omitted from this read-only tool — same decision as the destatis
reference. The engine turns a `98` into a clear error telling the user to
narrow the selection (`--start-year`/`--end-year`/`--timeslices`/
`--region-key`/`--class-key`).

## Conventions matched from the blueprint

- **Zero runtime HTTP dependencies** — only `commander`. Strict TS + ESM.
- **Exit codes** (`run.ts`): help/version → 0; usage/credential error → 2;
  not-found → 4; other errors → 1 (including auth failures, which additionally
  print a credentials hint).
- **Retry/backoff:** transient `429`/`503` retried up to `maxRetries`. GENESIS
  rate-limits on *concurrency* (logincheck reports killing requests beyond ~10
  parallel on this host) and does not reliably emit `429`/`503`, so this path is
  largely inert — keep it, don't rely on it.
- **`--base-url`** accepts only `http:`/`https:` and refuses embedded userinfo.
  Pointing it at the sibling DESTATIS/Zensus installations is possible but out
  of scope; note they use the **uppercase** `/genesisWS` path, so cross-pointing
  mostly 404s — use the right sibling CLI instead. The data terms also differ
  (rely on the response `Copyright`).

## Deliberate divergences from destatis-genesis-cli (summary)

1. **API path** `/genesisws/rest/2020` (lowercase) — uppercase 404s here.
2. **Default base URL** `https://www.regionalstatistik.de`.
3. **Env vars / bin name**: `REGIONALSTATISTIK_*`; the bin is `regstat`.
4. **Flat auth-error mapping** (engine `toApiError` + `checkLogicalStatus`):
   401+Code 15 and 404+Code 2 surface as typed errors with the GENESIS code;
   `isNotFound` ignores a 404 that carries a GENESIS code; run.ts prints a
   credentials hint on `isAuthError` (destatis only hints on HTTP 401/403).
   The destatis reference renders these poorly (exit 4 / no detail) — a
   backport candidate.
5. **BOM-tolerant HTML detection** in `toApiError` — this host's HTML error
   pages start with a UTF-8 BOM, which must not defeat the "don't dump HTML to
   stderr" check.
6. **whoami fixture/shape**: live reply has no `User-IP` (typed optional in both
   repos; the fixture here mirrors this host).
7. **Docs/examples/skills** use regional objects (`12411-01-01-4`, `KREISE`,
   AGS keys) and document AGS/ARS/regionale Tiefe in GLOSSARY.md.

## Testing

`node --test` on the compiled output; no jest/vitest. Tests inject a mock
`Transport` and a mocked `CliDeps` (`test/helpers.ts`, `test/fixtures.ts`); no
real network in the suite. Beyond the cloned destatis coverage, the
regionalstatistik-specific behaviour under test: flat Code 15/Code 2 mapping on
both 200 and 401/404 replies, `isNotFound` suppression for 404+Code 2, the 405
on GET, and the BOM-prefixed HTML error page (`engine.test.ts`, `cli.test.ts`).

## Verified live (2026-07-13, without an account)

- `helloworld/whoami` (GET, no auth) answers `{"User-Agent": …}`.
- POST without credentials → HTTP 401 + flat `{"Code":15,"Type":"ERROR",…}`.
- POST with wrong credentials → HTTP 404 + flat `{"Code":2,"Type":"ERROR",…}`.
- GET on an authenticated endpoint → HTTP 405.
- Uppercase `/genesisWS/...` → HTTP 404 + BOM-prefixed HTML page.
- `helloworld/logincheck` without credentials answers as guest
  (`"Username":"GAST"`) and mentions the ~10-parallel-requests limit.

## Still open

- The credentialed flow (`logincheck`, `find`, `catalogue`, `metadata`,
  `data table`, `data tablefile`) has not been exercised against this host with
  a real account yet — the shapes are asserted from the shared GENESIS software
  and the destatis reference's live verification.
- Whether this installation issues API tokens in its web UI (the engine
  supports token mode regardless; username/password is the documented default).
- Full `Status.Code` catalogue for finer exit-code mapping.

## Website

The project website — <https://maschinenlesbar-org.github.io/regionalstatistik-cli/> in English
and <https://maschinenlesbar-org.github.io/regionalstatistik-cli/de/> in German — is built from
`site/` with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web
components and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the
TypeDoc API reference under `/api/`. Its content comes from this repository: the README intro
and quick start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`),
`Usage.md`, `GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill
examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are
`site/_config.yml` and `site/_data/project.yml` (the German intro and the access requirements);
the rest of `site/` is identical in every maschinenlesbar.org CLI, so change it in all of them
together. When the README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/regionalstatistik-cli/
```
