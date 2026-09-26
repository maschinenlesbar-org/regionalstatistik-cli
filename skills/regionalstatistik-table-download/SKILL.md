---
name: regionalstatistik-table-download
description: >
  Export a Regionaldatenbank Deutschland table, cube, time series or saved
  result (regionalstatistik.de) to a file (CSV, flat "ffcsv", Excel, HTML or
  GENML) using the regionalstatistik-cli. Trigger when the user asks "download
  the population per Kreis as CSV", "save table 12411-01-01-4 for
  Baden-Württemberg to Excel", "export district unemployment figures to a
  spreadsheet", "give me the Gemeinde data as a file", or wants a
  spreadsheet-ready file rather than JSON in the terminal. Writes the
  server-rendered download (a ZIP) to a path you confirm, and reports what was
  written.
compatibility: >
  Requires the `regstat` CLI (npm package
  @maschinenlesbar.org/regionalstatistik-cli) on PATH, installed by the user;
  the skill never installs it. Network access to www.regionalstatistik.de. Needs
  a registered GENESIS account: --token or REGIONALSTATISTIK_API_TOKEN, or
  --username/--password or
  REGIONALSTATISTIK_USERNAME/REGIONALSTATISTIK_PASSWORD.
---

# Regionalstatistik Table Download

Save a Regionaldatenbank object as a file for spreadsheets or archiving,
instead of printing JSON. The `data/*file` endpoints return a server-rendered
**ZIP**; this skill writes those bytes to disk and tells the user exactly what
landed.

## Tooling

This skill drives the `regstat` command. **Before anything else, validate it is available** — run `command -v regstat` (or `regstat --version`). If it is not on your PATH, STOP and inform the user that the `regstat` CLI (`@maschinenlesbar.org/regionalstatistik-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**Credentials are required** for everything except `regstat hello`. The Regionaldatenbank needs a free registered account (mandatory since May 2025). Supply a login via `REGIONALSTATISTIK_USERNAME` + `REGIONALSTATISTIK_PASSWORD` (or `--username`/`--password`), or an API token via `REGIONALSTATISTIK_API_TOKEN` (or `--token`) if the account has one. There is **no bundled credential** — register at https://www.regionalstatistik.de/genesis/online. A command run without credentials exits `2` with guidance: stop and tell the user rather than retrying. Confirm access with `regstat logincheck`.

Resolve the object code with **regionalstatistik-statistics-finder** first if
you don't have it. Cite the response's `Copyright` for attribution
(DL-DE-BY-2.0).

## Step 1 — Choose the output path (confirm before writing)

Pick a concrete path and **confirm it with the user**, and **avoid clobbering
an existing file** — if the target exists, ask before overwriting or choose a
new name (the CLI itself refuses to overwrite unless `--force` is passed). The
download is a ZIP, so use a `.zip` extension.

## Step 2 — Download

```bash
regstat data tablefile 12411-01-01-4 --region-key "08*" --format ffcsv -o bevoelkerung-bw.zip
```

`data <kind>file <name>` — `kind` ∈ `table` · `cube` · `timeseries` · `result`.
The **same** selection filters as `data <kind>` apply
(`--region-var`/`--region-key`/`--start-year`/`--end-year`/`--class-var*`/
`--class-key*`), so narrow the export the same way — for this database that
means the **region key first** (`08*` = Baden-Württemberg's Kreise, `08221` =
Stadtkreis Heidelberg).

Formats (`--format`):

| Format | Use |
|---|---|
| `datencsv` (default) | GENESIS CSV, German layout |
| `ffcsv` | **flat/tidy CSV, English headers** — best for data tools |
| `csv` | plain CSV |
| `xlsx` | Excel workbook |
| `html` | HTML table |
| `genml` | GENESIS XML |

**Always pass `-o <file>`** — without it the raw ZIP bytes go to stdout and
will scramble the terminal.

## Step 3 — Report what was written

The CLI prints a stderr confirmation like
`Wrote 40213 bytes to bevoelkerung-bw.zip (Content-Type: application/zip)`.
Relay that to the user: the **path**, the **byte count**, and the **format**.
Report success only on exit `0`: when GENESIS sends a status reply instead of
the file, the CLI writes nothing, prints the `GENESIS status …` message and
exits non-zero.

```
Wrote bevoelkerung-bw.zip — 40,213 bytes, ffcsv (zipped).
Contents: table 12411-01-01-4, Kreise 08*, 2015–2023.
Source: Statistische Ämter des Bundes und der Länder, Regionaldatenbank Deutschland; DL-DE-BY-2.0.
Unzip with: unzip bevoelkerung-bw.zip
```

## Traps

- **It's a ZIP, not raw CSV.** Every `*file` format is delivered zipped; the
  file needs unzipping. Don't promise a directly-openable `.csv`.
- **Never omit `-o`** for a download — binary to a terminal is a mess.
- **Too large (`Status.Code 98`, exit 1)** still applies to `*file` on very
  large tables — narrow with `--region-key` and the year filters; the async job
  flow is not supported. Gemeinde-level exports without a region filter hit
  this quickly.
- **Not found is exit 4.** A code that does not exist comes back as
  `GENESIS status 104 … the server sent this status instead of a file` (rarely
  `Status.Code 90`) and nothing is written — re-resolve the code with
  **regionalstatistik-statistics-finder**. But an auth
  failure with wrong credentials exits **1** (GENESIS Code 2, oddly on HTTP
  404) — read the message before re-resolving anything.
- **Confirm the path and don't silently overwrite** — this skill writes to the
  user's filesystem; the CLI refuses existing targets without `--force`.
