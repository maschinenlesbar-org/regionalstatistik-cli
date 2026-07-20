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

```bash
export REGIONALSTATISTIK_USERNAME="…"
export REGIONALSTATISTIK_PASSWORD="…"    # or REGIONALSTATISTIK_API_TOKEN
```

Global options (valid on any command):

| Flag | Meaning |
|---|---|
| `--username <u>` · `--password <p>` | account login (env `REGIONALSTATISTIK_USERNAME` / `REGIONALSTATISTIK_PASSWORD`) |
| `--token <t>` | API token (env `REGIONALSTATISTIK_API_TOKEN`); wins over username/password |
| `--base-url <url>` | API base (default `https://www.regionalstatistik.de`) |
| `--language <de\|en>` | response language (default `de`; English labels are partial) |
| `--pagelength <n>` | max list results, `1..25000` (server default 100) |
| `--timeout <ms>` · `--max-retries <n>` · `--max-response-bytes <n>` | transport tuning |
| `--user-agent <ua>` | User-Agent header |
| `--compact` | single-line JSON |
| `-o, --output <file>` | write output (JSON, or a download) to a file instead of stdout |
| `--force` | overwrite the `--output` file if it already exists (otherwise the write is refused) |

## hello / logincheck

```bash
regstat hello           # helloworld/whoami — needs NO credentials
regstat logincheck      # helloworld/logincheck — validates your credentials
```

## find — full-text search

```bash
regstat find <term> [--category all|tables|statistics|cubes|variables|time-series]
```

`--pagelength` bounds the result count. Returns parallel arrays
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

```bash
regstat data tablefile 12411-01-01-4 --region-key "08*" --format ffcsv -o bevoelkerung-bw.zip
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); also an **empty result** — see note |
| `1` | API/logical error (including auth failures — Code 15/2), network or parse error |
| `2` | usage error (missing/partial credentials, bad flags/arguments, unknown command) |
| `4` | object not found — logical `Status.Code 90`, or an HTTP 404 without a GENESIS code (see note) |

> **A missing object code usually does not exit 4.** Looking up a code that does
> not exist on `metadata`/`data` typically returns `Status.Code 104` — a valid
> **empty** result, so the CLI exits **0**, the same as an empty
> `catalogue`/`find` search. To detect "no such object" in a script, inspect
> `Status.Code` in the payload, not the exit code.

> **A 404 is not always "not found" on this host.** Wrong credentials come back
> as HTTP 404 with a flat `{"Code":2,…}` body; the CLI recognizes the GENESIS
> code and exits **1** with the server's explanation, not 4.

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
  are auto-retried (`--max-retries`), not `500` or timeouts.
- **`"boolean"`/count fields are strings.** List items encode e.g. `Values` /
  `Cubes` counts and flags as JSON strings (`"9"`, `"true"`).
- **Confidentiality dots.** At fine regional depth many cells are `.`
  (suppressed for statistical confidentiality) — that is data, not an error.
- **Attribution.** Cite the `Copyright` field from each response — see
  [DATA_LICENSE.md](DATA_LICENSE.md).
