# Data license

> **This tool does not include, host, or redistribute any data.**
> `regionalstatistik-cli` is a *client*. It only accesses data served live by
> the **Statistische Ämter des Bundes und der Länder** via the Regionaldatenbank
> Deutschland's GENESIS API. That data is theirs and is governed by **their**
> terms, summarized below. The license of this CLI's own source code is a
> separate matter — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Statistische Ämter des Bundes und der Länder (published on their behalf by Landesbetrieb Information und Technik Nordrhein-Westfalen, IT.NRW) |
| **API / source** | `https://www.regionalstatistik.de/genesisws/rest/2020` · portal: https://www.regionalstatistik.de/genesis/online |
| **Data license** | **Datenlizenz Deutschland – Namensnennung – Version 2.0** (`DL-DE-BY-2.0`) |
| **License text** | https://www.govdata.de/dl-de/by-2-0 |
| **Attribution** | **Required** (provider name + `dl-de/by-2-0` reference). |
| **Commercial use** | **Allowed.** |
| **Redistribution / modification** | Allowed, with source attribution and changes marked. |

Verified against the site's Impressum on 2026-07-13, which states:
"Copyright © Statistische Ämter des Bundes und der Länder, 2026 — Datenlizenz
Deutschland – Namensnennung – Version 2.0". DL-DE-BY-2.0 is a permissive,
attribution-only open-data license: no share-alike, no non-commercial and no
no-derivatives clauses. The only obligations are to name the source and to mark
any changes.

## Attribution

Name the provider and the license, e.g.:

```
Datenquelle: Statistische Ämter des Bundes und der Länder, Regionaldatenbank Deutschland; <Abrufdatum>; Datenlizenz by-2-0
Data source: Statistische Ämter des Bundes und der Länder, Regionaldatenbank Deutschland; <date of retrieval>; Data licence by-2-0
```

If you alter or recompute the figures, append `; eigene Berechnung` /
`; own calculation` (or `eigene Darstellung` / `own representation`).

**Prefer the API's own attribution.** Every enveloped response carries a
`Copyright` field (e.g. `© Statistische Ämter des Bundes und der Länder, 2026;
Datenlizenz Deutschland – Namensnennung – Version 2.0`). Surface that value
**verbatim** rather than hardcoding a year — the API is the source of truth and
this CLI never rewrites it.

## Notes & caveats

- **A free registered account is required for API use** (mandatory since May
  2025). Register at https://www.regionalstatistik.de/genesis/online.
  Credentials are **personal** — never commit or share them.
- **Fair use.** The host limits *concurrency* (its logincheck message mentions
  terminating requests beyond ~10 parallel) rather than a published daily
  quota; the operators may change limits at any time. Bulk/very large tables
  use an async batch-job flow this CLI does not implement — narrow your
  selection instead (especially at Gemeinde depth).
- **No warranty from the provider.** The Impressum's Haftungsausschluss
  disclaims liability for correctness, completeness and availability of data
  and metadata. Verify against the source for anything important.
- **Sibling databases differ.** The same GENESIS software also powers the
  federal GENESIS-Online (`genesis.destatis.de`, © Statistisches Bundesamt) and
  the Zensus database. Their data terms are their own — rely on the
  per-response `Copyright` field for the actual host you queried.

## Sources

- https://www.govdata.de/dl-de/by-2-0 — DL-DE-BY-2.0 license text
- https://www.regionalstatistik.de/genesis/online?Menu=Impressum — Impressum with the copyright/license statement
- https://www.regionalstatistik.de/genesis/online?Menu=Webservice — API description, WADL/Swagger links, registration pointers

---

*Good-faith summary compiled 2026-07-13; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*
