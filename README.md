# regionalstatistik-cli

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

The command is **`regstat`**.

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

Precedence per field is **flag > env var > unset**; a token takes precedence
over username/password. Only `regstat hello` works without credentials.

> **Prefer the environment variables.** A credential passed as a `--token` /
> `--username` / `--password` **flag** is visible in the process table (`ps`,
> `/proc`) to other local users and is persisted in your shell history — the
> account *password* is especially sensitive. The CLI prints a one-line stderr
> warning when it detects a flag-supplied credential. Set the env var instead;
> it takes effect whenever the corresponding flag is absent.

```bash
export REGIONALSTATISTIK_USERNAME="your-username"
export REGIONALSTATISTIK_PASSWORD="your-password"
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
regstat logincheck                                   # validate your credentials
regstat find "bevölkerung kreise" --category tables  # search for tables
regstat catalogue tables "12411*"                    # browse tables by code
regstat metadata table 12411-01-01-4                 # describe a table
regstat data table 12411-01-01-4 --region-key 08221 --start-year 2020 --compact
regstat data tablefile 12411-01-01-4 --region-key "08*" --format ffcsv -o bevoelkerung-bw.zip
```

Every command prints the API's JSON envelope (including the `Copyright`
attribution and a `Status` object). See **[Usage.md](Usage.md)** for the full
command reference and **[GLOSSARY.md](GLOSSARY.md)** for the regional concepts
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

The client is usable independently of the CLI. Errors are typed
(`RegionalstatistikApiError`, `RegionalstatistikNetworkError`,
`RegionalstatistikParseError`, `RegionalstatistikUsageError`).

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
  [DEVELOPING.md](DEVELOPING.md)).
- **The data belongs to the Statistische Ämter des Bundes und der Länder, not
  us** — governed by DL-DE-BY-2.0. See **[DATA_LICENSE.md](DATA_LICENSE.md)**.
- **Code license:** AGPL-3.0-or-later **OR** commercial — see
  [LICENSING.md](LICENSING.md). External code contributions are not accepted
  ([CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and forks are welcome.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # builds, then runs node --test on dist/test
npm run typecheck
```

See [DEVELOPING.md](DEVELOPING.md) for architecture and API specifics.
