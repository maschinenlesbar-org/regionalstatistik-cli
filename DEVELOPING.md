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
    validate.ts  # input rules (…Problem functions) + assertValid
    query.ts     # dependency-free query-string builder
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building, retry, Status.Code logical-error mapping, URL redaction
    errors.ts    # Regionalstatistik{Error,ApiError,NetworkError,UsageError,ValidationError,ParseError}
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

## Library input validation

The library owns every rule about what a request may contain; the CLI only turns
argv strings into typed values and calls the same rules. The rules are pure,
exported `…Problem(value)` functions in `src/client/validate.ts` (they return the
reason a value is invalid, or `undefined`). The client enforces them before any
request through `assertValid(name, value, problem)`, which throws
**`RegionalstatistikValidationError`** (`Invalid <name>: <reason>`); a client
method rejects its promise, a constructor throws. `RegionalstatistikValidationError`
extends `RegionalstatistikUsageError`, so `run.ts` maps it to exit 2 and prints
`Error: <message>`. The CLI's commander parsers call the same `…Problem`
functions and turn a reason into commander's `InvalidArgumentError` (exit 2 too).
Parity tests (`test/parity.test.ts`, the `parity()` helper in `test/helpers.ts`)
drive one input through `run()` and through the library on one recording mock
transport and assert the same outcome.

What the library rejects:

- **Blank text** (`nonBlankProblem`, `assertRequestParams`): a blank (`""` or
  whitespace-only) object `name`, `find` `term`, or any given string parameter
  (`selection`, `area`, `type`, `regionalkey`, `classifyingkey1`, …).
  GENESIS reads an empty parameter as "no filter", so it would silently return
  unfiltered data. `undefined` still means "omitted". The CLI's `parseNonEmpty`
  calls the same rule.
- **Values outside a GENESIS value list** (`oneOfProblem`): `language` must be one
  of `LANGUAGES` (`de`, `en`) on every request path, `logincheck(language)`
  included; `find`'s `category` one of `FIND_CATEGORIES`;
  `searchcriterion`/`sortcriterion` one of `CRITERIA` (`Code`, `Content`); and a
  `data/*file` download's `format` one of `DATA_FILE_FORMATS` — exact,
  case-sensitive. The lists are exported from `params.ts` and the types derive from
  them; the CLI builds its `.choices()` from the same exports.
- **Out-of-range counts** (`intRangeProblem`): `pagelength` must be an integer from
  1 to `MAX_PAGELENGTH` (25000, exported from `params.ts`), `timeslices` a
  non-negative integer — `0` (for `pagelength`), `-1`, `1.5`, `NaN`, `Infinity`
  and `25001` never reach the server. The CLI's `parseBoundedInt` parses the
  string and applies the same rule; `--pagelength` takes its bound from
  `MAX_PAGELENGTH`.
- **Out-of-range engine limits** (`intRangeProblem`, in the `RequestEngine`
  constructor): `timeoutMs` must be an integer from 0 to `MAX_TIMEOUT_MS`,
  `maxRetries` from 0 to `MAX_RETRIES` (10, exported from `engine.ts`), and
  `maxResponseBytes`/`retryDelayMs` non-negative safe integers. A negative or `NaN`
  timeout or size cap used to switch that guard off, and `maxRetries` had no
  bound. A `timeoutMs` above `MAX_TIMEOUT_MS` is now rejected rather than clamped
  (the default transport still clamps a direct `nodeHttpTransport` call). The
  CLI's `--timeout`/`--max-retries` parsers take their bounds from the same
  constants.
- **Header values** (`headerValueProblem`, `credentialProblem`, `headerNameProblem`):
  `userAgent` and every `defaultHeaders` value must be non-blank, free of control
  characters (CR/LF included, tab allowed) and within Latin-1; a `defaultHeaders`
  name must be an HTTP token. Only `userAgent: undefined` selects the default. A
  `token`/`username`/`password` must also have no leading or trailing whitespace
  (the server would strip it, so a different credential would be checked). A
  *blank* credential still counts as unset in the library (so
  `token: process.env.REGIONALSTATISTIK_API_TOKEN` works with an empty variable),
  and so does a blank credential env var in the CLI; only a blank credential
  *flag* is a CLI usage error, because it would silently cancel an env
  credential. Messages never echo the value. The CLI's
  `parseHeaderValue`/`parseCredential` (and the env-var check in `program.ts`)
  call the same rules; the secret flags use `parseSecret`, which throws
  `RegionalstatistikUsageError` naming the flag and the reason only (commander's
  own wording, `argument '<value>' is invalid`, would print the password).
- **Secrets in library objects** (P2): the client keeps the token, username and
  password in real `#private` fields, so `console.log(client)`, `util.inspect` and
  `JSON.stringify` never show them. Every error the engine raises is scrubbed of the
  request's credential values (raw, JSON- and URL-escaped; `redactSecrets`): the
  `message`, `detail` and `body` of a `RegionalstatistikApiError` (a server may echo them —
  `logincheck` returns the token as `Username`), a transport's error text and the
  `cause` chain (`scrubThrown` copies an error only when its text carries one).
- **Redaction on output** (`run.ts`, `withRedactedOutput`, P1): commander echoes
  rejected values and names unknown commands and options as typed, so `run()`
  wraps `deps.io` first and replaces, on stdout and stderr, the userinfo of every
  URL-like argument (`credentialsIn`, exported, parseable or not) with `***@`, and
  the whole values of `--token`/`--username`/`--password`, of the three
  `REGIONALSTATISTIK_*` variables and of any token-shaped argument (`looksLikeToken`) with
  `***` (`redactSecrets`: whole occurrences only, values under 4 characters
  skipped). `withoutStrayValues` drops the value from commander's "too many
  arguments" and `--x=value` "unknown option" errors, and from "unknown command"
  unless it reads like a command name — that is where a secret typed without its
  flag lands.
- **Base URL** (`baseUrlProblem`, run by the engine constructor on the raw
  `baseUrl` before the trailing-slash strip): an unparsable URL, a scheme other
  than `http:`/`https:`, embedded userinfo (`https://u:p@host` would become a Basic
  `Authorization` header; GENESIS never uses Basic auth), a query or fragment
  (request paths are appended as a string, so `?`/`#` would swallow them),
  surrounding whitespace (`"https://h/ "` requested `/%20/…`), and whitespace or
  control characters inside it. This is a configuration error, so it throws
  `RegionalstatistikValidationError`, not `RegionalstatistikNetworkError`; only the
  default transport's per-hop scheme check (`http.ts`) is a network error.
  Messages never echo the URL. `parseBaseUrl` calls `baseUrlProblem` and only
  appends the flag hint for an embedded credential.
- **Wrong types** (`plainObjectProblem`, `functionProblem`, P13): a JavaScript
  caller's `find(null)`, `catalogue.tables("x")`, `data.table(name, 5)`, a non-object
  `options` or `defaultHeaders`, a non-function `transport` or `sleep`, and a
  non-string `token`/`username`/`password`/`userAgent` (`Expected a string.`) are a
  `RegionalstatistikValidationError`, never a raw `TypeError` — and never sent: spreading a
  string parameter object used to send `0=x`. Server text in an error (`detail` and
  the message) is cut at `MAX_MESSAGE_VALUE_LENGTH` (500) characters; `body` keeps the
  full answer.
- **Half a credential pair** (`credentialPairProblem`): with no token, a
  `username` without a `password` (or the reverse) throws at construction —
  `Invalid credentials: Provide both username and password (or a token).` A lone
  username used to go out in the token's wire format, a lone password was dropped.
  The CLI's `resolveCredentials` keeps only the flag > env precedence; `action()`
  builds the client first and rewords this error with the flags and env vars.
- **No credentials for an account-only endpoint** (`credentialsRequiredProblem`):
  `find()`, `catalogue.*`, `metadata.*` and `data.*` reject before any request
  when the client has no credentials (a blank one counts as none) —
  `Invalid credentials: This endpoint needs an account (a token, or a username and
  password).` Anonymously GENESIS would answer 401 + Code 15 after the round trip.
  `whoami()` and `logincheck()` keep optional credentials: a credential-less
  `logincheck` answers as the guest user `GAST` (verified live), and the CLI's
  `logincheck` now sends it too instead of refusing it. The CLI has no presence
  guard of its own: `action()` rewords this error with the flags, env vars and
  signup URL (exit 2, message unchanged).

Request defaults: neither side fills in a value the caller did not give. The CLI
has no `.default()` for `--language` or `find --category`, so an omitted value is
not sent — by the CLI or the library — and GENESIS applies its own defaults
(`de`, `all`); the help text says so.

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
`REGIONALSTATISTIK_API_TOKEN`, in `program.ts`; values checked by the library's
`credentialProblem`, precedence in `shared.ts:resolveCredentials`). A token wins over username/password, except
that a `--username`/`--password` *flag* beats an env-only token (commander's
value source tells flag from env); supplying only one of username/password is
rejected by the library (see above) and reworded by the CLI with the flags (exit 2). Flag values are checked by their parser
(`parseCredential`, the library's `credentialProblem`); an env value is seeded unchecked and validated in
`shared.ts:action()` only when the command is about to send it, so a malformed
env var never breaks `--help`, `--version`, `hello` or a run whose flag
overrides it. No
credential is ever bundled.

Answers are decoded by the charset their `Content-Type` names (`decodeBody`,
`TextDecoder`; UTF-8 when none, a byte-order mark dropped); an unknown label is a
`RegionalstatistikParseError` (P8). GENESIS declares `charset=UTF-8`; a mirror or
proxy in ISO-8859-1 would otherwise turn every umlaut into U+FFFD.

**Redirects are NOT followed.** Following a cross-origin redirect would forward
the credential headers to another origin; a 3xx surfaces as an error hinting at
the canonical host (`https://www.regionalstatistik.de`). That has to hold for
custom transports too (P3): `fetch` follows redirects by default and strips only
`Authorization` across origins, not the custom `username`/`password` headers. So
every `HttpRequest` carries `redirect: "manual"` (a fetch transport passes it on),
and a response whose reported final URL (`HttpResponse.url`, fetch's `r.url`) is
on another origin is rejected as a `RegionalstatistikNetworkError` instead of
being returned as data. `test/redirect-credentials.test.ts` runs a pair of local
servers, one redirecting to the other, and checks that the second receives
nothing.
`engine.ts:redactUrl` additionally scrubs any `username`/`password` that a
caller managed to put in a URL (defensive — this client keeps them in headers).

### 3. HTTP 200 does not mean success — and auth errors are not enveloped

GENESIS answers HTTP 200 for most *logical* errors and carries the real outcome
in a `Status` object (`{ Code, Content, Type }`). After a successful parse,
`engine.ts:checkLogicalStatus` inspects it:

| `Status.Code` | Handling |
|---|---|
| `0`, `22` (auto-corrected), `50` (no newer data) | success — returned as-is (the envelope's `Status.Content` carries any warning) |
| `104` | **empty result** — returned as a valid empty list, NOT an error (except on a `data/*file` download, below) |
| `90` | object not found → `RegionalstatistikApiError`, `isNotFound` (exit 4) |
| `98` | too large → `RegionalstatistikApiError` with narrowing guidance (exit 1) |
| any `Type` = `Fehler`/`Error` | → `RegionalstatistikApiError` (exit 1), even without a numeric `Code` |
| any other code, whatever its `Type` (`Information`, `Warnung`) | → `RegionalstatistikApiError` (exit 1) — never data with exit 0 |

The code is read as a number, a numeric string (`"90"`) included (`statusCode`).

A `data/*file` endpoint answers with a file (a ZIP wrapper), so `postRaw` treats
any JSON or empty reply as a failure rather than a download. A body counts as JSON
when its Content-Type says so **or** it starts with `{` (after an optional BOM) —
the server labels some replies `text/plain` or `application/octet-stream`. An
empty body or JSON without a GENESIS status → `RegionalstatistikParseError`; a
GENESIS status → the mapping above, and otherwise a `RegionalstatistikApiError`
carrying that status — `104` included, which there means "no such object"
(`isNotFound`, exit 4). An HTML page (by Content-Type or a leading
`<!doctype html`/`<html`) that is not a ZIP is a `RegionalstatistikParseError`
too, unless the call asked for `format: "html"` (P9). Nothing is written.

The JSON endpoints check the documented shape after the status mapping
(`shapeProblem`, P9): `find`, `catalogue`, `metadata` and `data` must answer with
the envelope — an object whose `Status` is an object with a numeric `Code`, its
lists (`List`, `Tables`, …) arrays or `null`, its `Object` an object or `null` —
and `whoami` with an object carrying `User-Agent`. `null`, `{}`, `[]`, a bare
string or an unrelated error object is a `RegionalstatistikParseError` (exit 1),
never data. `logincheck` has its own check (below).

**Divergence from the destatis reference (its engine misses this):**
authentication failures arrive as a **flat, envelope-less**
`{ "Code": …, "Content": …, "Type": "ERROR" }` JSON body, paired with a
misleading HTTP status (verified live on both hosts):

| Reply | Meaning | This CLI |
|---|---|---|
| HTTP **401** + flat `Code 15` ("Sie sind nicht berechtigt …") | no/unrecognized credentials | exit 1 + credentials hint (`isAuthError`) |
| HTTP **404** + flat `Code 2` ("… prüfen … Nutzernamen bzw. das Passwort") | wrong credentials | exit **1** (NOT 4 — see below) + credentials hint (`isAuthError`) |
| HTTP **200** + flat `Code 2` or `15` (sent on 200 in July 2026) | wrong / missing credentials | the same: `checkLogicalStatus` carries `httpStatus: 200` for the flat shape, so `isAuthError` holds |

`engine.ts` therefore extracts a GENESIS status from non-2xx bodies too
(`toApiError`), *and* maps the flat shape on 2xx replies defensively
(`checkLogicalStatus`). `RegionalstatistikApiError.isNotFound` only treats an
HTTP 404 as "object not found" when the body carried **no** GENESIS code —
otherwise the 404-for-bad-credentials would masquerade as a missing object and
exit 4. destatis-genesis-cli exits 4 in that case; this repo deliberately does
not. Key off the numeric `Code`, never the German/English `Type` text alone.

`helloworld/logincheck` is different again (P18): it answers HTTP **200** whether
or not the credentials are right, with a *string* `Status` and the `Username` the
server logged in. Live (2026-10-05), wrong credentials give `{"Status":"Ein Fehler
ist aufgetreten. (Bitte prüfen und korrigieren Sie Ihren Nutzernamen bzw.\n das
Passwort.)","Username":"<the token, or the user name sent>"}`; no credentials give
the guest answer `{"Status":"Sie wurden erfolgreich an- und abgemeldet! Bei mehr
als 10 parallelen Requests …","Username":"GAST"}`. `engine.ts:postLoginCheck`
evaluates the answer with `loginVerdict` (exported): an error text, an error
`Type` or a `Code` other than 0/22 (string, enveloped or flat `Status`), or an
unrecognised text with the token echoed as `Username`, is a
`RegionalstatistikApiError` with `loginRejected` (so `isAuthError`: exit 1 +
credentials hint); a success text (or Code 0) with a non-empty `Username`
resolves — the guest answer included, since `logincheck` needs no credentials
here; anything else confirms nothing and is a `RegionalstatistikParseError`. A
success text wins over the token echo, since whether GENESIS echoes a *valid*
token is unknown (no account to check). An error word anywhere in the text wins
over a success word, so a future notice appended to the success text that
contains one ("nicht", "Fehler") would turn a good login into exit 1 — loudly,
not silently. Shared with destatis-genesis-cli:
`test/conformance-p18-genesis-access-check.test.ts`.

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

### 6. The transport contract is the engine's, not the transport's

`Transport` is exported, so library users plug in `fetch` or their own `node:http`
wrapper. The engine (`request()`/`callTransport()` in `engine.ts`) keeps its promises
for every transport (P5):

- **`timeoutMs`** — the call runs under an overall deadline: the request carries an
  `AbortSignal` (`HttpRequest.signal`, which the default transport honours and a fetch
  transport passes on) and the engine rejects with `RegionalstatistikNetworkError` at the
  deadline whether the transport stops or not.
- **`maxResponseBytes`** — checked again on the body the transport hands back
  (`sizeLimitMessage` names the option and `--max-response-bytes`).
- **Response shape** — `headers` may be a `Headers` object, a `Map` or a record with
  names in any case (`plainHeaders`), so `Retry-After` and `Content-Type` are read;
  `body` may be any `ArrayBuffer` view or `ArrayBuffer`, from any realm (`bodyBytes`).
  Anything else (`responseProblem`: no status, no headers, a string body) is a
  `RegionalstatistikNetworkError`.
- **Errors** — whatever a transport throws (fetch's `TypeError`, a string, `null`)
  becomes a `RegionalstatistikNetworkError` naming the request, with the original (scrubbed)
  as `cause`. A reset is not retried, from any transport: only 429/503 are.

## Conventions matched from the blueprint

- **Zero runtime HTTP dependencies** — only `commander`. Strict TS + ESM.
- **Exit codes** (`run.ts`): help/version → 0 (commander's own exit code 0);
  usage/credential error → 2, including a missing command (bare `regstat`,
  `regstat data`), which prints the help to stderr;
  not-found → 4; other errors → 1 (including auth failures, which additionally
  print a credentials hint).
- **Retry/backoff:** transient `429`/`503` retried up to `maxRetries` (0..`MAX_RETRIES` = 10, enforced by the engine),
  each after the linear backoff (`retryDelayMs` × attempt), or the response's
  `Retry-After` (delay-seconds or an IMF-fixdate) when that is longer — never
  sooner, so `Retry-After: 0` or a past date can't make a burst (P6). A malformed
  one falls back to the backoff; one above 30 s is not retried, and the error says
  how long the server asked to wait. GENESIS rate-limits on *concurrency*
  (logincheck reports killing requests beyond ~10 parallel on this host) and does
  not reliably emit `429`/`503`, so this path is largely inert — keep it, don't
  rely on it.
- **`--base-url`** accepts only `http:`/`https:` and refuses embedded userinfo,
  a query, a fragment, and whitespace or control characters (paths are appended
  as a string; the engine applies the same `baseUrlProblem` for library users).
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
   credentials hint on `isAuthError` (Code 15, a flat Code 2 on any HTTP
   status, HTTP 401/403) worded by `RegionalstatistikApiError.credentialsSent`: "check
   your credentials" when a `username` header went out, "refused the request
   without credentials" when none did, and no hint for `hello` (whoami takes
   none). destatis-genesis-cli has the same mapping since 2026-09-26.
5. **BOM tolerance** — this host's HTML error pages start with a UTF-8 BOM,
   which must not defeat the "don't dump HTML to stderr" check in `toApiError`.
   A leading BOM is also dropped before every JSON parse (success bodies, error
   bodies, and the `data/*file` sniff), so a BOM-prefixed status reply is read
   like a plain one.
6. **whoami fixture/shape**: live reply has no `User-IP` (typed optional in both
   repos; the fixture here mirrors this host).
7. **Docs/examples/skills** use regional objects (`12411-01-01-4`, `KREISE`,
   AGS keys) and document AGS/ARS/regionale Tiefe in GLOSSARY.md.

## Testing

`node --test` on the compiled output; no jest/vitest. Node 22.12 or later
(`engines`); CI (`ci.yml`) type-checks, builds and tests on Node 22/24. Tests inject a mock
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
