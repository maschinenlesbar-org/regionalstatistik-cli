# Skills

`regionalstatistik-cli` ships **Claude Code Agent Skills** as a Claude Code
plugin, so Claude can drive the `regstat` CLI for common regional
official-statistics tasks. The skills **validate** that the `regstat` CLI is on
your PATH and tell you if it is missing — they never install anything.

| Skill | Use it when you want to… |
|---|---|
| **regionalstatistik-statistics-finder** | Turn a regional topic into a concrete object code — search (`find`), browse by code (`catalogue`), and confirm structure and regional variables (`metadata`). |
| **regionalstatistik-data-fetch** | Pull the actual numbers for a known code, narrowed by AGS region key and years, and decode the German-format CSV in `Object.Content`. |
| **regionalstatistik-table-download** | Export a table/cube/time series to a file (CSV, tidy `ffcsv`, Excel, …) via the `data/*file` endpoints. |

They compose: **finder → data-fetch** (or **→ table-download**).

## Requirements

- The `regstat` CLI on PATH: `npm install -g @maschinenlesbar.org/regionalstatistik-cli`.
- **Credentials** (except `regstat hello`): a free Regionaldatenbank account
  (registration mandatory since May 2025). Set `REGIONALSTATISTIK_USERNAME` +
  `REGIONALSTATISTIK_PASSWORD` (or `REGIONALSTATISTIK_API_TOKEN`). Register at
  https://www.regionalstatistik.de/genesis/online. No credential is bundled.

## Installing the plugin

This repo is a Claude Code plugin (`.claude-plugin/plugin.json` + `skills/`),
published as `regionalstatistik` in the
[maschinenlesbar.org plugin marketplace](https://github.com/maschinenlesbar-org/plugins).
Install it inside Claude Code to enable the three skills:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install regionalstatistik@maschinenlesbar
```

The `skills/` and `.claude-plugin/` files are **not** shipped in the npm tarball
— the published package is the client/CLI only.

The data these skills surface belongs to the Statistische Ämter des Bundes und
der Länder, under DL-DE-BY-2.0 — see [DATA_LICENSE.md](DATA_LICENSE.md). Cite
the `Copyright` field from each response.
