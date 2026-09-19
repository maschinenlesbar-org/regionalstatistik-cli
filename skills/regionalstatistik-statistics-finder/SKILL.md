---
name: regionalstatistik-statistics-finder
description: >
  Find the right regional official-statistics object (table, statistic, cube or
  time series) in Germany's Regionaldatenbank (regionalstatistik.de) using the
  regionalstatistik-cli. Trigger when the user asks "which table has population
  per Kreis?", "find official statistics on unemployment by district",
  "Einwohnerzahl von Heidelberg?", "Arbeitslosenquote je Kreis?", "which
  regionalstatistik table covers Gemeinde-level land use?", or needs to turn a
  regional topic into a concrete object code before pulling numbers. Searches
  with find, narrows with catalogue, and confirms the structure with metadata —
  handing back the exact code and the regional variables to filter by.
compatibility: >
  Requires the `regstat` CLI (npm package
  @maschinenlesbar.org/regionalstatistik-cli) on PATH, installed by the user;
  the skill never installs it. Uses jq for JSON filtering. Network access to
  www.regionalstatistik.de. Needs a registered GENESIS account: --token or
  REGIONALSTATISTIK_API_TOKEN, or --username/--password or
  REGIONALSTATISTIK_USERNAME/REGIONALSTATISTIK_PASSWORD.
---

# Regionalstatistik Statistics Finder

Turn a regional topic into a concrete GENESIS object **code** (e.g. table
`12411-01-01-4`) that later data commands can fetch. The Regionaldatenbank is
code-driven: you cannot pull data until you know the code, and this skill is
how you get there — including the **regional variable** (KREISE, GEMEIN, …)
needed to slice by district or municipality.

## Tooling

This skill drives the `regstat` command. **Before anything else, validate it is available** — run `command -v regstat` (or `regstat --version`). If it is not on your PATH, STOP and inform the user that the `regstat` CLI (`@maschinenlesbar.org/regionalstatistik-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**Credentials are required** for everything except `regstat hello`. The Regionaldatenbank needs a free registered account (mandatory since May 2025). Supply a login via `REGIONALSTATISTIK_USERNAME` + `REGIONALSTATISTIK_PASSWORD` (or `--username`/`--password`), or an API token via `REGIONALSTATISTIK_API_TOKEN` (or `--token`) if the account has one. There is **no bundled credential** — register at https://www.regionalstatistik.de/genesis/online. A command run without credentials exits `2` with guidance: stop and tell the user rather than retrying. Confirm access with `regstat logincheck`.

Pass `--compact` so each result is one line for `jq`. Add `--language en` for
English labels (partial). Cite the `Copyright` field from any response you show.

## Step 1 — Search by topic

```bash
regstat --compact find "bevölkerung kreise" --category tables --pagelength 20
```

- `--category` ∈ `all` · `tables` · `statistics` · `cubes` · `variables` ·
  `time-series`. Start with `tables` (the usable 2-D views); widen to `all` if
  nothing fits.
- `find` returns **parallel arrays** `Tables` / `Statistics` / `Cubes` /
  `Timeseries` / `Variables`, each `null` when not searched. Read the array
  that matches your category.

Each item: `Code` (the code you want) and `Content` (its German title). Titles
state the regional depth ("regionale Tiefe: Kreise und krfr. Städte").

## Step 2 — Narrow by code with `catalogue`

Once you know the statistic's EVAS prefix, browse by code with a `*` wildcard:

```bash
regstat --compact catalogue tables "12411*"
regstat --compact catalogue statistics "12*" --sort-criterion Content
```

Subcommands: `tables` · `statistics` · `cubes` · `timeseries` · `variables` ·
`values`. Code structure: `12` (area) → `12411` (statistic, "Fortschreibung des
Bevölkerungsstandes") → `12411-01-01-4` (table). The **trailing digit is the
regional depth**: `…-4` = Kreise und kreisfreie Städte, `…-5` = Gemeinden —
pick the depth the user actually asked about. This is the reliable way to
enumerate all tables of a statistic.

## Step 3 — Confirm structure with `metadata`

Before handing off a code, check it is the right shape:

```bash
regstat --compact metadata table 12411-01-01-4
```

`metadata <kind> <name>` (`kind` ∈ table/statistic/cube/timeseries/variable/value)
returns an `Object` describing the table's dimensions and value ranges — so you
can tell the user *what breakdowns and years* it offers, which **regional
variable** applies (`KREISE`, `GEMEIN`, …, for `--region-var`/`--region-key`)
and which `--class-var`/`--class-key` filters exist.

## Step 4 — Report

Give the user the **code**, its title, the regional depth, and (from metadata)
the available dimensions and time span, then offer to fetch the data (hand off
to **regionalstatistik-data-fetch**) or download a file
(**regionalstatistik-table-download**).

```
Match: table 12411-01-01-4 — "Bevölkerungsstand: Bevölkerung nach Geschlecht — Kreise und krfr. Städte"
  Statistic: 12411 (Fortschreibung des Bevölkerungsstandes)
  Regional depth: Kreise (AGS keys like 08221 = Heidelberg)
  → fetch with: regstat data table 12411-01-01-4 --region-key 08221
```

## Traps

- **Empty result ≠ error.** A search/catalogue with no matches comes back with
  `Status.Code 104` and exits `0` (an empty list) — it means "nothing matched",
  not a failure. Broaden the term or category.
- **`find` arrays can be `null`.** Don't assume every array is present; read
  the one for your `--category`.
- **Codes are exact.** `metadata`/`data` take a precise `name` (e.g.
  `12411-01-01-4`), not a wildcard. Use `catalogue tables "12411*"` to
  discover, then a full code to fetch.
- **Match the regional depth to the question.** "Einwohner von Heidelberg" needs
  a Kreis-level table (`…-4`); a Gemeinde question needs `…-5`. Same statistic,
  different table.
- **`Values`/`Cubes` counts are strings** (`"9"`, not `9`) — don't do math on
  them without parsing.
- Don't guess a code from memory — always resolve it via `find`/`catalogue`.
