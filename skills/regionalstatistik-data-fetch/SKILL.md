---
name: regionalstatistik-data-fetch
description: >
  Fetch and interpret the actual numbers from a Regionaldatenbank Deutschland
  table, cube or time series (regionalstatistik.de) using the
  regionalstatistik-cli, then explain the returned CSV. Trigger when the user
  asks "Einwohnerzahl von Heidelberg?", "population of a German district over
  time", "Arbeitslosenquote je Kreis?", "pull table 12411-01-01-4 for
  Baden-Württemberg", "how many inhabitants does Kreis 08221 have?", or has an
  object code and wants values narrowed by year and region. Handles the
  region-key/region-var and year filters and decodes the ";"-delimited
  German-format CSV that arrives inside Object.Content.
version: 1.0.0
userInvocable: true
---

# Regionalstatistik Data Fetch

Pull statistical data for a known object **code** and turn the raw response
into readable numbers. GENESIS returns the table as a delimited CSV **string**
inside `Object.Content`, in German number format — the value of this skill is
fetching the right *regional* slice and decoding it correctly.

## Tooling

This skill drives the `regstat` command. **Before anything else, validate it is available** — run `command -v regstat` (or `regstat --version`). If it is not on your PATH, STOP and inform the user that the `regstat` CLI (`@maschinenlesbar.org/regionalstatistik-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**Credentials are required** for everything except `regstat hello`. The Regionaldatenbank needs a free registered account (mandatory since May 2025). Supply a login via `REGIONALSTATISTIK_USERNAME` + `REGIONALSTATISTIK_PASSWORD` (or `--username`/`--password`), or an API token via `REGIONALSTATISTIK_API_TOKEN` (or `--token`) if the account has one. There is **no bundled credential** — register at https://www.regionalstatistik.de/genesis/online. A command run without credentials exits `2` with guidance: stop and tell the user rather than retrying. Confirm access with `regstat logincheck`.

If you don't have the object code yet, resolve it first with
**regionalstatistik-statistics-finder**. Always cite the response `Copyright`
field.

## Step 1 — Fetch the data, narrowed by region

```bash
regstat --compact data table 12411-01-01-4 --region-key 08221 --start-year 2015
```

`data <kind> <name>` — `kind` ∈ `table` · `cube` · `timeseries` · `result`.
The regional filters are the point of this database; narrow the request (both
to answer precisely and to avoid the too-large error):

| Flag | Effect |
|---|---|
| `--region-key <key>` | the region(s) by official AGS/ARS key; `*` wildcard ok. `08221` = Stadtkreis Heidelberg, `08*` = every Kreis in Baden-Württemberg |
| `--region-var <code>` | the regional level to slice by (e.g. `KREISE`, `GEMEIN`) — usually optional when the table's depth already matches |
| `--start-year <YYYY>` · `--end-year <YYYY>` | limit the time range |
| `--timeslices <n>` | only the latest `n` periods |
| `--class-var1..5 <code>` · `--class-key1..5 <key>` | filter a classifying variable (e.g. Geschlecht) to specific values |
| `--contents <labels>` | restrict to specific value columns |
| `--transpose` | swap rows/columns for readability |

Discover the valid `--region-var` / `--class-var*` codes from
`regstat metadata table <name>` first.

## Step 2 — Decode `Object.Content`

The payload is a **`;`-delimited, newline-terminated CSV string** in German
locale:

- **Decimal comma, thousands dot** — `162.273` inhabitants is ~162 thousand;
  `1.234,5` is 1234.5. Convert before doing arithmetic.
- **Value-status symbols** appear instead of numbers: `-` (none / nil), `.`
  (unknown or confidential — very common at fine regional depth), `...` (not
  yet available), `/` (not meaningful), `x` (not applicable), `()` (limited
  value), `p` (provisional), `r` (revised), `s` (estimated). Report these
  as-is; never coerce them to `0`.
- Rows are keyed by the **AGS key + region name** (e.g.
  `08221;Heidelberg, Stadtkreis;…`). The leading lines are headers (statistic
  code, dimension labels); the data rows follow. Read the `Object.Structure`
  (add `--structure`) if you need the dimension tree to label columns.

## Step 3 — Report

Present the figures as a small table with a one-line source note. Keep the
original units and any status symbols.

```
Bevölkerung, Stadtkreis Heidelberg (table 12411-01-01-4, AGS 08221), Stichtag 31.12.:
  2020  159.245
  2021  158.741
  2022  161.485
  2023  162.273
Source: Statistische Ämter des Bundes und der Länder, Regionaldatenbank Deutschland; DL-DE-BY-2.0.
```

## Traps

- **HTTP 200 is not success.** The CLI already maps the logical `Status` for
  you: a real failure is a non-zero exit with a clear message. But if you
  inspect raw JSON, check `Status.Code` (`0`/`22` ok, `90` not found, `98` too
  large).
- **Too large (`Status.Code 98`, exit 1).** The table is too big for a direct
  fetch and this CLI does not run the async batch-job flow. **Narrow** — on
  this database that means `--region-key` first (Gemeinde-level tables are
  huge), then `--start-year`/`--end-year`/`--timeslices`. Do not retry
  unchanged. For a file export, hand off to **regionalstatistik-table-download**.
- **Auth failures are exit 1 with a hint** (GENESIS Code 15 = no credentials
  recognized, Code 2 = wrong username/password — the server oddly pairs the
  latter with HTTP 404). Fix the credentials; don't re-resolve the code.
- **Not found is exit 4** (logical `Status.Code 90`). Re-resolve with the
  finder skill.
- **German number format** — always convert decimal-comma before math, and
  never silently drop value-status symbols; a `.` cell is *confidential*, not
  zero.
- **Empty (`Status.Code 104`, exit 0)** means your filters excluded everything —
  check the AGS key (Kreis keys are 5 digits, Gemeinde/AGS 8) and loosen the
  year filters.
