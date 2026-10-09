# regionalstatistik-cli

[![CI](https://github.com/maschinenlesbar-org/regionalstatistik-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/regionalstatistik-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/regionalstatistik-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/regionalstatistik-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/regionalstatistik-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/regionalstatistik-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/regionalstatistik-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/regionalstatistik-cli/de/) — command reference, guides and API docs

A TypeScript **API client and CLI** for the **Regionaldatenbank Deutschland**
GENESIS REST API (version 2020) at
[www.regionalstatistik.de](https://www.regionalstatistik.de) — Germany's
regional official-statistics database, run by the statistical offices of the
Bund and the Länder. It carries the official figures **below** the federal
level: down to Regierungsbezirk, **Kreis** (district) and **Gemeinde**
(municipality) — population, employment, elections, land use, and much more,
keyed by the official AGS/ARS regional codes.

Search the catalogue, read object metadata, and pull statistical tables, cubes
and time series from the command line or as a library. Read-only, zero runtime
HTTP dependencies (built on `node:http`/`https`), strict TypeScript, ESM.

```bash
npm install -g @maschinenlesbar.org/regionalstatistik-cli
```

The command is **`regstat`**. Requires **Node.js 22.12+**.

## Credentials

The Regionaldatenbank requires a **free registered account** for API use
(mandatory since May 2025) — register at
[www.regionalstatistik.de/genesis/online](https://www.regionalstatistik.de/genesis/online).
Authenticate with your **username + password**, or with a personal **API token**
if your account provides one (GENESIS "Webservice/API" section). No credential
is bundled with this tool.

| How | Flag | Env var |
|-----|------|---------|
| Username + password | `--username <u>` / `--password <p>` | `REGIONALSTATISTIK_USERNAME` / `REGIONALSTATISTIK_PASSWORD` |
| Token | `--token <t>` | `REGIONALSTATISTIK_API_TOKEN` |

Precedence per field is **flag > env var > the credentials file > unset** (the
file is consulted only when no flag and no env var gives any credential — see
*Store it once* below); a token takes precedence
over username/password — except that a `--username`/`--password` **flag** beats
a token from `REGIONALSTATISTIK_API_TOKEN`, so the account you name on the
command line is the one used, and the CLI says on stderr that the env token is
not used. Fields mix: `--username` on the command line takes its password from
`REGIONALSTATISTIK_PASSWORD` (and `--password` its username from
`REGIONALSTATISTIK_USERNAME`). Only `regstat hello` works without credentials
(and `regstat logincheck`, which then answers as the guest user `GAST`).
Credentials are sent exactly as given: a blank credential flag, or one with
leading or trailing whitespace (which an HTTP header cannot carry), is refused
with exit 2; a blank env var counts as unset. A `--password` value that starts
with `--` is refused too (exit 2, nothing sent): `--password --compact` almost
always means the password is missing and the next option was taken for it. A
password that really starts with `--` goes in `REGIONALSTATISTIK_PASSWORD`.
No message repeats a credential: the CLI prints `***` in place of the token,
username and password (from flags, env vars or the credentials file) and of any `user:pass@` in a URL,
wherever they would appear — a usage error, an unknown command, the server's echo.

Credentials travel in HTTP header fields, so they can hold only Latin-1
characters (up to U+00FF). A character beyond that (`€`, an emoji) is refused
with exit 2 before anything is sent. Latin-1 characters such as `ä` are sent as
single ISO-8859-1 bytes, not UTF-8; whether GENESIS accepts an umlaut password
in that encoding has not been verified.

> **Prefer the environment variables.** A credential passed as a `--token` /
> `--username` / `--password` **flag** is visible in the process table (`ps`,
> `/proc`) to other local users and is persisted in your shell history — the
> account *password* is especially sensitive. The CLI logs a warning on stderr
> (`WARN  [regstat.cli] …`) when it detects a flag-supplied credential. Set the env var instead;
> it takes effect whenever the corresponding flag is absent — or store the login
> once with `regstat config set` (below).

```bash
export REGIONALSTATISTIK_USERNAME="your-username"
export REGIONALSTATISTIK_PASSWORD="your-password"
```

**Or store it once**, in a credentials file of its own (the same mechanism as
[openka-cli](https://github.com/maschinenlesbar-org/openka-cli)'s `ka config`):

```bash
regstat config set username                  # typed at a prompt, without echo
regstat config set password
regstat config set token                     # or a token instead of the pair
printf %s "$TOKEN" | regstat config set token  # or piped in
regstat config get token                     # masked: 0123…cdef (--reveal prints it whole)
regstat config list                          # what is stored, and where (a password, and any value below 20 characters, shows as ****)
regstat config unset password
```

The value is never taken from the command line, so it reaches neither shell history
nor `ps`. The file is `$XDG_CONFIG_HOME/regionalstatistik/credentials` (else
`~/.config/regionalstatistik/credentials`): mode 0600 in a directory of mode 0700,
replaced atomically by one writer at a time (`credentials.lock` beside it; a second
`config set` waits up to 2 s, then fails with exit 1 and changes nothing), and not read at all while anyone else could read it. It is
consulted only when no flag and no env var gives any credential — no token, no
username, no password — so a login is never pieced together from two places; from the
file, too, a token wins over username and password, and a username without a password
is refused (exit 2). A stored value follows the same rules as a flag (no surrounding
whitespace, Latin-1 only; spaces inside a password are fine) and is kept out of the
output like one from the environment. `regstat config` prints to stdout only: `-o` is
refused (exit 2; redirect stdout instead), so a value never lands on the terminal when
a file was asked for.

**Base URL.** `--base-url` (default `https://www.regionalstatistik.de`) takes
`http:` too, for a local mirror or a test server. When it points at plain `http:`
on a host other than loopback (`localhost`, `127.0.0.0/8`, `::1`), every run prints
one stderr line before the first request, naming the host and what travels in
the clear — `WARN  [regstat.http] the login is sent unencrypted to mirror.example (http:, not https:)`,
"the token" in token mode, or just `requests to … are sent unencrypted` for
`hello`. It never shows a credential, and stdout and the exit code stay as they
are. Library users get the same check as `cleartextProblem(baseUrl, secrets)`.

**The log on stderr.** Data goes to stdout; each line on stderr is a **log record**: a
timestamp (UTC), a level (`ERROR`, `WARN`, `INFO`) and a topic, the program and the area
it comes from (`regstat.cli` for usage errors and credential notes, `regstat.api` for
GENESIS's answers, a malformed one included, `regstat.http` for the connection, `regstat.config` for the
credentials file, `regstat.output` for the `-o` file and stdout — each with its
successes and its failures). By default it is written log4j style; `--log-format jsonl`
writes one JSON object per line instead. A record is always one line: a line
break, a control character or a bidi control in a message (a server's text, a value you
typed) is written as an escape (`\n`, `\u001b`, `\u202e`), so it can neither split a
record nor forge another one, nor steer the terminal; a message longer than 4000
characters is cut and ends in `… (N more characters)`. A credential is kept out of both:

```text
2026-10-09T14:03:12.481Z WARN  [regstat.http] the login is sent unencrypted to mirror.example (http:, not https:)
2026-10-09T14:03:12.902Z ERROR [regstat.api] GENESIS status 2 (ERROR) / HTTP 404 for POST …
2026-10-09T14:03:12.902Z INFO  [regstat.api] check your credentials (--token or --username/--password, or the ones stored with `regstat config`).
```

```bash
regstat --log-format jsonl logincheck 2>log.jsonl   # {"ts":"…","level":"ERROR","topic":"regstat.api","msg":"…"}
```

## Quickstart

Table codes look like `12411-01-01-4` — statistic `12411` (Fortschreibung des
Bevölkerungsstandes), table `01-01`, regionale Tiefe `4` (Kreise und
kreisfreie Städte). Regional filters are the point of this database:
`--region-var` picks the level (e.g. `KREISE`), `--region-key` the region(s) by
AGS key (`08*` = every Kreis in Baden-Württemberg, `08221` = Stadtkreis
Heidelberg).

```bash
regstat hello                                        # connectivity check (no auth)
regstat logincheck                                   # validate your credentials (exit 1 if rejected)
regstat find "bevölkerung kreise" --category tables  # search for tables
regstat catalogue tables "12411*"                    # browse tables by code
regstat metadata table 12411-01-01-4                 # describe a table
regstat data table 12411-01-01-4 --region-key 08221 --start-year 2020 --compact
regstat data tablefile 12411-01-01-4 --region-key "08*" --format ffcsv -o bevoelkerung-bw.zip
```

Every command prints the API's JSON envelope (including the `Copyright`
attribution and a `Status` object). `-o <file>` writes it (or a download) to a
file instead; `-o -` means stdout. See **[Usage.md](https://github.com/maschinenlesbar-org/regionalstatistik-cli/blob/main/Usage.md)** for the full
command reference and **[GLOSSARY.md](https://github.com/maschinenlesbar-org/regionalstatistik-cli/blob/main/GLOSSARY.md)** for the regional concepts
(AGS/ARS keys, regionale Tiefe, Kreis/Gemeinde levels, `Status.Code` values).

## Library use

```ts
import { RegionalstatistikClient } from "@maschinenlesbar.org/regionalstatistik-cli";

const rdb = new RegionalstatistikClient({
  username: process.env.REGIONALSTATISTIK_USERNAME,
  password: process.env.REGIONALSTATISTIK_PASSWORD,
});
const hits = await rdb.find({ term: "Bevölkerung Kreise", category: "tables" });
const table = await rdb.data.table("12411-01-01-4", { regionalkey: "08221", startyear: "2020" });
// table.Object.Content is the table as a ";"-delimited CSV string.
```

Each call accepts only the parameter keys of its endpoint: GENESIS ignores one it
does not know (a misspelt `startYear`) and would answer unfiltered, so the client
rejects it with `RegionalstatistikValidationError` before any request. Pass
`{ allowUnknownParams: true }` as the last argument to send a newer parameter anyway.

The client is usable independently of the CLI. Errors are typed
(`RegionalstatistikApiError`, `RegionalstatistikNetworkError`,
`RegionalstatistikParseError`, `RegionalstatistikUsageError`). A custom
`transport` (e.g. one built on `fetch`) gets the same guarantees as the built-in
one: `timeoutMs` and `maxResponseBytes` are enforced by the client, a `Headers`
object or `Uint8Array` body is read correctly, and whatever the transport throws
arrives as a `RegionalstatistikNetworkError`. A transport must not follow
redirects — GENESIS credentials are headers that `fetch` would carry to another
host — so pass `redirect: req.redirect` (always `"manual"`) to `fetch`, and
return `url: r.url`: a response from another origin is then refused.

## Relation to sibling tools

- **[destatis-genesis-cli](https://github.com/maschinenlesbar-org/destatis-genesis-cli)**
  wraps the *same* GENESIS API family at the Federal Statistical Office
  (genesis.destatis.de): **federal**-level statistics, usually down to
  Bundesland. This repo is its near-clone for the **regional** database —
  same envelope, same command set, different host, credentials and data depth.
- **regionalatlas-cli** covers the Regionalatlas (ArcGIS-served, *mapped*
  regional indicators). Use the Regionalatlas for ready-made indicator maps;
  use this CLI for the underlying **raw tables** with full control over years,
  regions and classifying variables.

## Notes

- **HTTP 200 ≠ success.** GENESIS reports logical outcomes in a `Status` object
  in the body; this client inspects `Status.Code` and raises
  `RegionalstatistikApiError` for real errors. Authentication failures arrive as
  a flat `{Code, Content, Type}` JSON on HTTP 401/404 — mapped too (see
  [DEVELOPING.md](https://github.com/maschinenlesbar-org/regionalstatistik-cli/blob/main/DEVELOPING.md)).
- **The data belongs to the Statistische Ämter des Bundes und der Länder, not
  us** — governed by DL-DE-BY-2.0. See **[DATA_LICENSE.md](DATA_LICENSE.md)**.
- **Code license:** AGPL-3.0-or-later **OR** commercial — see
  [LICENSING.md](LICENSING.md). External code contributions are not accepted
  ([CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and forks are welcome.

## Claude Code skills

Three [Agent Skills](https://github.com/maschinenlesbar-org/regionalstatistik-cli/blob/main/SKILLS.md) teach Claude Code to use this CLI for real questions:
turn a regional topic into an object code (**regionalstatistik-statistics-finder**), fetch its
numbers by region and year (**regionalstatistik-data-fetch**), and export tables to CSV or
Excel (**regionalstatistik-table-download**). Install them from the maschinenlesbar.org marketplace:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install regionalstatistik@maschinenlesbar
```

See **[SKILLS.md](https://github.com/maschinenlesbar-org/regionalstatistik-cli/blob/main/SKILLS.md)** for details.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # builds, then runs node --test on dist/test
npm run typecheck
```

See [DEVELOPING.md](https://github.com/maschinenlesbar-org/regionalstatistik-cli/blob/main/DEVELOPING.md) for architecture and API specifics.
