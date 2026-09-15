# Glossary

Concepts of the Regionaldatenbank Deutschland and the vocabulary this CLI
exposes. The database runs the GENESIS software: **statistics** are made of
**cubes**, which are sliced into **tables**, described by **variables** and
their **values** — and almost everything here additionally has a **regional
dimension** reaching down to Kreis and Gemeinde level.

## Objects

| Term | GENESIS | Meaning |
|---|---|---|
| **Statistic** (Statistik) | `statistic` | A whole statistical product, keyed by a 5-digit EVAS code (e.g. `12411`, "Fortschreibung des Bevölkerungsstandes"). Contains cubes. |
| **Table** (Tabelle) | `table` | A ready-made 2-D view, keyed like `12411-01-01-4`. The main thing you fetch. |
| **Cube** (Datenquader) | `cube` | The raw multidimensional data behind tables. |
| **Time series** (Zeitreihe) | `timeseries` | A cube reduced to a single value over time. |
| **Variable** (Merkmal) | `variable` | A dimension/attribute (e.g. `KREISE` = Kreise und kreisfreie Städte, `GES` = Geschlecht). |
| **Value** (Ausprägung) | `value` | A concrete value of a variable (e.g. one specific Kreis). |
| **Result** (Ergebnistabelle) | `result` | A table produced by an async job, saved in your user area. |

## Codes & selection

- **EVAS code** — the numeric statistic key. `12` (subject area) → `12411`
  (statistic).
- **Table codes** look like `12411-01-01-4`: EVAS statistic, table number, and a
  trailing digit for the **regionale Tiefe** (regional depth) — e.g. `…-4` =
  Kreise und kreisfreie Städte, `…-5` = Gemeinden. The deeper the table, the
  bigger it is: filter Gemeinde-level tables with `--region-key` or you will hit
  the too-large error (98).
- **`selection`** — a code filter for `catalogue` browsing; supports a `*`
  wildcard, e.g. `12411*` matches all objects whose code starts `12411`.
- **`name`** — the exact object code passed to `metadata`/`data`.
- **`regionalvariable` / `regionalkey`** (CLI: `--region-var` / `--region-key`)
  — **the point of this database.** The regional level to slice by, and the
  region(s) to include, selected by their official key. `*` wildcards work:
  `--region-key "08*"` selects every Kreis in Baden-Württemberg,
  `--region-key 08221` just Stadtkreis Heidelberg. Discover the valid regional
  variables of a table with `regstat metadata table <code>`.
- **`classifyingvariable{n}` / `classifyingkey{n}`** (CLI: `--class-var{n}` /
  `--class-key{n}`) — restrict a `data` request to specific non-regional
  variable values (e.g. Geschlecht).

## Regional keys & levels

- **AGS** (Amtlicher Gemeindeschlüssel) — the official 8-digit municipality key
  `LL R KK GGG`: Land (2), Regierungsbezirk (1), Kreis (2), Gemeinde (3).
  Truncations address the higher levels: `08` = Baden-Württemberg (Land),
  `08221` = Stadtkreis Heidelberg (Kreis level).
- **ARS** (Amtlicher Regionalschlüssel) — the 12-digit variant
  `LL R KK VVVV GGG` that additionally encodes the **Gemeindeverband** (VVVV).
- **Regionale Tiefe** — the depth a table is published at: Deutschland → Land →
  Regierungsbezirk / Statistische Region → Kreise und kreisfreie Städte →
  Gemeindeverbände → Gemeinden. Typical regional variables: `DINSG`
  (Deutschland), `DLAND` (Bundesländer), `REGBEZ` (Regierungsbezirke), `KREISE`
  (Kreise und kreisfreie Städte), `GEMEIN` (Gemeinden) — confirm per table via
  `metadata`, they vary.
- **Kreis / kreisfreie Stadt** — district / district-free city, the NUTS-3
  level; **Gemeinde** — municipality (LAU level); **Gemeindeverband** —
  association of municipalities.
- **NUTS** — the EU regional classification. Roughly: NUTS-1 = Länder, NUTS-2 =
  Regierungsbezirke/Statistische Regionen, NUTS-3 = Kreise; Gemeinden are LAU.
  The database keys by AGS/ARS, not NUTS.

## The response envelope

Every non-`helloworld` response is wrapped:

| Field | Meaning |
|---|---|
| `Ident` | `{ Service, Method }` — which endpoint answered. |
| `Status` | `{ Code, Content, Type }` — the **logical** outcome (see below). |
| `Parameter` | echo of your request (credentials masked as `********`). |
| `Copyright` | the attribution string to cite — see [DATA_LICENSE.md](DATA_LICENSE.md). |
| `List` | catalogue results (a homogeneous array). |
| `Object` | data/metadata payload (opaque; for `data/table`, a CSV string in `Object.Content`). |

`helloworld/whoami` and `helloworld/logincheck` do **not** use this envelope —
and neither do **authentication failures**, which arrive as a bare
`{ Code, Content, Type }` object (see below).

## `Status.Code` values

Most logical outcomes ride on HTTP `200`; auth failures pair the same shape
with 401/404:

| Code | Type | Meaning | This CLI |
|---|---|---|---|
| `0` | Information | success | returns data |
| `22` | Warnung | success, a parameter was auto-corrected | returns data (warning visible in `Status.Content`) |
| `50` | Information | no newer data (for `--stand`) | returns data |
| `104` | Information | no object matched | returns an **empty** result (exit 0) |
| `90` | Fehler | requested object not found | error, **exit 4** |
| `98` | Information | result too large for a direct fetch | error with narrowing guidance, exit 1 |
| `15` | ERROR | not authorized (no/unrecognized credentials; flat body on HTTP 401) | error + credentials hint, exit 1 |
| `2` | ERROR | wrong username/password (flat body on HTTP **404** — not a missing object!) | error, exit 1 |
| any | Fehler / Error | general error | error, exit 1 |

## Value-status placeholders

In a `data/table` CSV, a cell may be a status symbol instead of a number:
`-` (nothing to report / genuine zero context), `.` (unknown/secret — common at
Gemeinde level due to statistical confidentiality), `...` (not yet available),
`/` (no figure: value not reliable enough), `x` (no meaningful statement
possible), `()` (limited informative value), `p` (provisional), `r` (revised),
`s` (estimated).

## Auth terms

- **Username / password** — the account login for the free registration at
  https://www.regionalstatistik.de/genesis/online (mandatory for API use since
  May 2025). Required together.
- **API token** — a personal token generated in the GENESIS web UI
  ("Webservice/API" section) where offered. Placed in the `username` request
  field with no password; wins over username/password when both are set.

See [DEVELOPING.md](DEVELOPING.md) for how credentials are passed on the wire
and why redirects are not followed.
