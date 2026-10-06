# Usage

`regstat <command> [options]`. Every command hits the Regionaldatenbank's
GENESIS 2020 REST API and prints its JSON envelope (`Ident` / `Status` /
`Parameter` / `Copyright` plus `List` or `Object`). Object codes are EVAS-style
with a regional-depth suffix (e.g. table `12411-01-01-4`, statistic `12411`) —
find them with `find` / `catalogue`.

## Credentials & global options

Set credentials once (see [README](README.md)). Prefer the **environment
variables** over the flags: a credential passed as a flag is visible in the
process table and shell history, so the CLI warns to stderr when it detects one.
Nothing the CLI prints repeats a credential: the token, username and password
(flag or env var) and any `user:pass@` in a URL show as `***` — in usage errors, in
an unknown command or surplus argument, and in a server answer that echoes them.

```bash
export REGIONALSTATISTIK_USERNAME="…"
export REGIONALSTATISTIK_PASSWORD="…"    # or REGIONALSTATISTIK_API_TOKEN
```

Global options (valid on any command). Each option takes one value: giving one
twice (`--start-year 2020 --start-year 2021`, `--token a --token b`) is a usage
error (exit 2), not "the last one wins".

| Flag | Meaning |
|---|---|
| `--username <u>` · `--password <p>` | account login (env `REGIONALSTATISTIK_USERNAME` / `REGIONALSTATISTIK_PASSWORD`); per field, so `--username` from a flag can take its password from the env var. A `--password` value starting with `--` is a usage error (exit 2) — usually a missing password that took the next option; put such a password in the env var |
| `--token <t>` | API token (env `REGIONALSTATISTIK_API_TOKEN`); wins over username/password, but a `--username`/`--password` flag beats a token from the env var — the CLI then says on stderr that the env token is not used |
| `--base-url <url>` | API base (default `https://www.regionalstatistik.de`); `http(s)` only, a path prefix is fine, but no query, fragment, userinfo, whitespace or control characters. A plain `http:` URL to a host other than loopback prints one `warning:` line on stderr (see below) |
| `--language <de\|en>` | response language (not sent unless given; the server default is `de`; English labels are partial) |
| `--pagelength <n>` | max list results, `1..25000` (server default 100) |
| `--timeout <ms>` · `--max-retries <n>` · `--max-response-bytes <n>` | transport tuning |
| `--user-agent <ua>` | User-Agent header |
| `--compact` | single-line JSON |
| `-o, --output <file>` | write output (JSON, or a download) to a file instead of stdout; `-o -` means stdout |
| `--force` | overwrite the `--output` file if it already exists (otherwise the run is refused before any request is sent — also when a symlink, even a dangling one, sits at that path) |

**Plain `http:`.** With a `--base-url` on plain `http:` to a host other than
loopback (`localhost`, `127.0.0.0/8`, `::1`), each run writes one line to stderr
before its first request, naming the host and what is sent unencrypted:

```text
warning: the login is sent unencrypted to mirror.example:8080 (http:, not https:)
warning: the token is sent unencrypted to mirror.example:8080 (http:, not https:)
warning: requests to mirror.example:8080 are sent unencrypted (http:, not https:)
```

"the login" is a username + password, "the token" token mode, and the last form
is a run that sends no credentials (`hello`, a guest `logincheck`). The line never
contains a credential; stdout and the exit code are unchanged, and `--help`,
`--version` and a usage error (one found before the first request) print none.

## hello / logincheck

```bash
regstat hello           # helloworld/whoami — needs NO credentials (ignores any set)
regstat logincheck      # helloworld/logincheck — validates your credentials
                        # (without any it answers as the guest user, "Username": "GAST")
```

`logincheck` exits **0** only when GENESIS confirms the login. GENESIS answers it
with HTTP 200 either way; wrong credentials come back as an error text in `Status`
(and a wrong token echoed as `Username`), which the CLI reports as `GENESIS login
rejected (HTTP 200) …` plus the credentials hint, exit **1**. An answer that confirms
nothing (no `Status`, no `Username`) exits 1 without the hint.

## find — full-text search

```bash
regstat find <term> [--category all|tables|statistics|cubes|variables|time-series]
```

Without `--category` no category is sent and GENESIS searches every object type
(`all`). `--pagelength` bounds the result count. Returns parallel arrays
(`Tables`/`Statistics`/`Cubes`/`Timeseries`/`Variables`), each `null` when not
searched.

```bash
regstat find "bevölkerung kreise" --category tables --pagelength 20
regstat find "arbeitslosenquote" --category tables
```

## catalogue — browse objects by code

```bash
regstat catalogue <sub> [selection] [--area <a>] [--search-criterion Code|Content]
                                    [--sort-criterion Code|Content] [--type <t>]
```

`<sub>` ∈ `tables` · `statistics` · `cubes` · `timeseries` · `variables` ·
`values` · `terms` · `jobs` · `modified` · `results` · `qualitysigns`.
`[selection]` filters by code and accepts a `*` wildcard (e.g. `12411*`).
Alias: `cat`.

```bash
regstat catalogue statistics "12*"
regstat catalogue tables "12411*" --sort-criterion Content
```

## metadata — describe an object

```bash
regstat metadata <kind> <name> [--area <a>]
```

`<kind>` ∈ `table` · `statistic` · `cube` · `timeseries` · `variable` · `value`.
Alias: `meta`. Use this to learn a table's **regional variables** (e.g.
`KREISE`) and classifying variables before fetching data.

```bash
regstat metadata table 12411-01-01-4
regstat metadata variable KREISE
```

## data — fetch statistical data

```bash
regstat data <kind> <name> [selection filters]
```

`<kind>` ∈ `table` · `cube` · `timeseries` · `result`. The result carries the
table as a `";"`-delimited CSV string in `Object.Content` (German number
format — comma decimals; `.` `-` `x` `/` `…` are value-status placeholders).

Selection filters (narrow large tables — see the too-large note below). The
**regional filters are the point of this database**:

| Flag | GENESIS param |
|---|---|
| `--region-var <code>` · `--region-key <key>` | `regionalvariable` / `regionalkey` — the regional level (e.g. `KREISE`, `GEMEIN`) and the region(s) by AGS/ARS key; `*` wildcard ok (`08*` = all Kreise in Baden-Württemberg) |
| `--start-year <YYYY>` · `--end-year <YYYY>` | `startyear` / `endyear` |
| `--timeslices <n>` | `timeslices` (from the latest period back) |
| `--class-var1..5 <code>` · `--class-key1..5 <key>` | `classifyingvariable{n}` / `classifyingkey{n}` |
| `--contents <labels>` | `contents` (comma-separated) |
| `--stand <DD.MM.YYYY>` | `stand` (only newer data) |
| `--structure` · `--transpose` · `--compress` | `structureinformation` / `transpose` / `compress` |

```bash
# Population of Stadtkreis Heidelberg since 2015
regstat data table 12411-01-01-4 --region-key 08221 --start-year 2015

# All Kreise of Baden-Württemberg, latest year only
regstat data table 12411-01-01-4 --region-key "08*" --timeslices 1
```

### File downloads

```bash
regstat data <kind>file <name> -o <file> [--format datencsv|csv|ffcsv|xlsx|html|genml] [filters]
```

`<kind>file` ∈ `tablefile` · `cubefile` · `timeseriesfile` · `resultfile`. The
server returns a **ZIP** wrapper; the bytes are written as-is to `-o <file>` (or
stdout). `ffcsv` is a tidy/flat CSV with English headers; `datencsv` is the
default.

A JSON or empty reply is never written as a download: it is a GENESIS status the
server sent instead of the file. The CLI recognises it by its content (a body
starting with `{`), whatever the Content-Type says, then writes nothing and exits
non-zero — **4** for `Status.Code 104` (no object with that code) or `90`, **1**
for anything else (credentials, `98` too large, an empty body). An HTML page (a
maintenance or proxy page) is refused the same way, exit **1** — unless it is a
ZIP, or you asked for `--format html`.

```bash
regstat data tablefile 12411-01-01-4 --region-key "08*" --format ffcsv -o bevoelkerung-bw.zip
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (`--help`, `help` and `--version` included); also an **empty result** — see note |
| `1` | API/logical error (including auth failures — Code 15/2, also on HTTP 200 — and any `Status.Code` other than 0, 22, 50, 104 or 90), network or parse error |
| `2` | usage error (missing/partial credentials, bad flags/arguments, unknown command, and no command at all: bare `regstat` or `regstat data` prints the help to stderr and exits 2) |
| `4` | object not found — logical `Status.Code 90`, or an HTTP 404 without a GENESIS code (see note), and a `data <kind>file` download for a code that does not exist (`Status.Code 104`) |

A reader that stops early (`regstat catalogue tables '12411*' | head`) ends the run
quietly with exit `0`; a failed run keeps its own code even when its stderr reader
is gone (`2>&1 | true`).

> **A missing object code usually does not exit 4.** Looking up a code that does
> not exist on `metadata`/`data` typically returns `Status.Code 104` — a valid
> **empty** result, so the CLI exits **0**, the same as an empty `catalogue`
> search or a filter that excludes every row: a 104 alone can't tell a wrong code
> from an over-narrow filter, so check the code with `catalogue tables "<code>"`
> first. (A `data <kind>file` download is the exception:
> there `104` means there is nothing to download, so it exits **4** and writes no
> file.) To detect "no such object" in a script, inspect
> `Status.Code` in the payload, not the exit code.

> **A 404 is not always "not found" on this host.** Wrong credentials come back
> as HTTP 404 with a flat `{"Code":2,…}` body; the CLI recognizes the GENESIS
> code and exits **1** with the server's explanation and a
> `Hint: check your credentials` line, not 4. (`regstat hello` sends no
> credentials, so a 401/403 there gets no such hint.) `logincheck` gets the same
> text on an HTTP 200 instead; it exits **1** with the hint too
> (`GENESIS login rejected (HTTP 200) …`).

## Gotchas

- **Wrong path case = HTML 404.** The REST base is lowercase
  `/genesisws/rest/2020` on this host; the destatis-style `/genesisWS/...`
  returns an HTML error page. Relevant only if you tinker with `--base-url`.
- **Too-large tables.** A table too big to return synchronously fails with
  `Status.Code 98`; this read-only CLI does not run the async batch-job flow.
  Narrow the request — on this database usually with `--region-key` (Gemeinde
  tables are huge) plus `--start-year`/`--end-year`/`--timeslices`.
- **Pagination.** GENESIS paginates by `--pagelength` only (no offset/cursor);
  narrow with `selection`/`term` rather than paging.
- **Concurrency limit.** `logincheck` reports that requests are killed beyond
  roughly 10 parallel ones on this host. Keep requests serial. Only `429`/`503`
  are auto-retried (`--max-retries`, each after a linear backoff of 200 ms ×
  attempt, or the server's `Retry-After` when that is longer, up to 30 s — a
  longer one is not retried, and the error names the requested wait), not `500`,
  resets or timeouts.
- **`"boolean"`/count fields are strings.** List items encode e.g. `Values` /
  `Cubes` counts and flags as JSON strings (`"9"`, `"true"`).
- **Confidentiality dots.** At fine regional depth many cells are `.`
  (suppressed for statistical confidentiality) — that is data, not an error.
- **Attribution.** Cite the `Copyright` field from each response — see
  [DATA_LICENSE.md](DATA_LICENSE.md).
