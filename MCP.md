# regstat-mcp

An [MCP](https://modelcontextprotocol.io/) server for the
[Regionaldatenbank Deutschland](https://www.regionalstatistik.de/genesis/online), the regional
official statistics of the statistical offices of the Bund and the Länder, as tools for AI agents.
Read-only.

The Regionaldatenbank holds Germany's official statistics down to the Kreise and Gemeinden
(population, labour, economy, education, elections and more) as tables, cubes and time series,
on the GENESIS software. The data is under the Datenlizenz Deutschland – Namensnennung 2.0
(attribution); the API needs a free, personal account (mandatory since May 2025).

It is the MCP side of [regionalstatistik-cli](https://github.com/maschinenlesbar-org/regionalstatistik-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/regionalstatistik-mcp
```

This installs the **`regstat-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/regionalstatistik-mcp:latest
```

## Login

The Regionaldatenbank needs a personal account: a token, or a username and password
([register](https://www.regionalstatistik.de/genesis/online), free). **No login is bundled.** The server takes it,
at the first tool call, from:

1. its environment (what an MCP client's config sets): `REGIONALSTATISTIK_API_TOKEN`, or
   `REGIONALSTATISTIK_USERNAME` and `REGIONALSTATISTIK_PASSWORD`;
2. else the login stored with `regstat config set token` (or `username` and `password`; the
   CLI's credentials file, `$XDG_CONFIG_HOME/regionalstatistik/credentials`, else
   `~/.config/regionalstatistik/credentials`; a file others can read is refused, naming the fix).

One login from one place: a token together with a username or password, half a pair, or one part
from the environment and the other from the file is refused, naming what to change (the CLI lets a
token win over a username and password; the server, configured once, asks for one). One INFO
record on stderr says where the login came from, never a value; the token, username and password
are replaced with `***` in every log record, result and error. The server takes no login on its
command line. Without one, every tool call is an error that says what to set (and the next call
looks again); a login GENESIS refuses is an error that says to check it (`regstat logincheck`)
and restart the server. The Regionaldatenbank serves nothing without an account, so there is no
guest mode.

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add regstat -- regstat-mcp
# or with the image:
claude mcp add regstat -- docker run -i --rm ghcr.io/maschinenlesbar-org/regionalstatistik-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "regstat": { "command": "regstat-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "regstat": { "type": "stdio", "command": "regstat-mcp" } } }
```

To give the login in the entry rather than the credentials file, add
`"env": { "REGIONALSTATISTIK_API_TOKEN": "…" }`. With the image, pass it through: `docker run -i --rm -e
REGIONALSTATISTIK_API_TOKEN ghcr.io/maschinenlesbar-org/regionalstatistik-mcp:latest`.

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`) the server calls GENESIS with your
account for whoever reaches it, so it **refuses to start without `--auth-token-file <path>`** and
then answers only requests that send that bearer token (`Authorization: Bearer <token>`; anything
else is 401). The file holds one token of at least 32 characters, mode 600, owned by the user the
server runs as; it is read once, at start, and the token is never logged:

```bash
(umask 077; openssl rand -hex 32 > ~/.config/regionalstatistik/mcp-token)
regstat-mcp --transport http --auth-token-file ~/.config/regionalstatistik/mcp-token   # http://127.0.0.1:3000/mcp
claude mcp add --transport http regstat http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $(cat ~/.config/regionalstatistik/mcp-token)"
```

In a container, publish the port on loopback only, mount the token file read-only and run the
container as the file's owner (the server reads only its own user's token file):
`docker run --rm -p 127.0.0.1:3000:3000 --user "$(id -u):$(id -g)" -e REGIONALSTATISTIK_API_TOKEN -v "$HOME/.config/regionalstatistik/mcp-token:/run/secrets/mcp-token:ro" ghcr.io/maschinenlesbar-org/regionalstatistik-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1 --auth-token-file /run/secrets/mcp-token`.
The token travels unencrypted over plain HTTP: beyond this machine, put a TLS proxy in front.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/regionalstatistik-cli/releases) instead of
`latest`: `…/regionalstatistik-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/regionalstatistik-mcp:<version> --repo maschinenlesbar-org/regionalstatistik-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `fetchData` | The figures of a table, cube, time series or saved result for the regions asked for (official AGS keys: `08221` Heidelberg, `08*` every Kreis of Baden-Württemberg), narrowed further by years and up to five classifying variables; GENESIS's German-format CSV decoded line by line (numbers as numbers, region keys as text with their leading zeros, value symbols kept and named). An empty answer says whether the code doesn't exist or the selection excluded everything. |
| `findStatistics` | A topic to object codes: GENESIS's full-text search over tables (default), statistics, cubes, time series and variables, with each table's regional depth (Kreise, Gemeinden). |
| `getFlatTable` | A table as GENESIS's flat CSV ("ffcsv": one row per value, every dimension a column), unpacked from the download's ZIP, as columns and rows a page at a time. The server writes no file. |
| `describeObject` | An object's title, regional depth, time span and dimensions (the variable codes `fetchData` filters by), from its metadata. |
| `browseCatalogue` | The tables, statistics, cubes, time series, variables or values whose code (or title) matches a pattern (`12411*`: a statistic's tables at every depth, `…-4` Kreise, `…-5` Gemeinden). |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (the endpoint and its parameters, never the login), the data licence and
GENESIS's own `copyright`. A failure is a tool error that says what to change. A table too large
for a direct fetch is refused by GENESIS (status 98): narrow it, by region key first (a Gemeinde
table without one is huge); this server, like the CLI, doesn't run GENESIS's batch jobs.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters); required
--base-url <url>           API base URL (default https://www.regionalstatistik.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **HTTP only with a bearer token** (see above): your GENESIS account must not become an open
  endpoint. It listens on loopback by default; it checks the `Host` header and, from a browser, the
  `Origin` (only the origins given with `--allowed-origins`, matched exactly) against DNS rebinding
  and other web pages. Exposed beyond localhost (it logs a warning then), it belongs behind a TLS
  proxy.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time (the host ends
  requests beyond about 10 in parallel per account) and 120 a minute to the API, pauses on HTTP 429
  (as long as its Retry-After asks, at most 30 s), and stops a tool call after its deadline.
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio it ends at once, and when stdin ends.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/regionalstatistik-cli/blob/main/LICENSING.md)).
Data: the figures come from the Statistische Ämter des Bundes und der Länder, served live, under the
[Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0):
commercial use and redistribution are allowed with the source named and changes marked. Quote
"Datenquelle: Statistische Ämter des Bundes und der Länder, Regionaldatenbank Deutschland;
<Abrufdatum>; Datenlizenz by-2-0" (add "; eigene Berechnung" for figures you computed), or the answer's own `copyright`.
Every result carries this in its `licence` field
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/regionalstatistik-cli/blob/main/DATA_LICENSE.md)).
We provide the tool, not the data. The login is yours and personal: don't share the server's
endpoint or its token with others.
