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
token win over a username and password; the server, configured once, asks for one). One INFO record
on stderr says where the login came from, never a value; the token, username and password are
replaced with `***` in every log record, result and error (a value shorter than 16 characters, such
as a username, only where it stands whole: the username `Bund` leaves "Bundesländer" in the data
alone). The server takes no login on its command line. Without one, every tool call is an error that
says what to set (and the next call looks again); a login GENESIS refuses is an error that says to
check it (`regstat logincheck`) and restart the server. The Regionaldatenbank serves nothing without
an account, so there is no guest mode.

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

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`) the server calls GENESIS with your account
for whoever reaches it, so it **refuses to start without `--auth-token-file <path>`** and then
answers only requests that send that bearer token (`Authorization: Bearer <token>`; anything else is
401). The file holds one token of at least 32 characters, mode 600, owned by the user the server
runs as, a regular file (a FIFO is refused at once, never waited on); it is read once, at start, and
the token is never logged:

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
| `fetchData` | The figures of a table, cube, time series or saved result for the regions asked for (official AGS keys: `08221` Heidelberg, `08*` every Kreis of Baden-Württemberg), narrowed further by years and up to five classifying variables; GENESIS's German-format CSV decoded line by line (numbers as numbers, a figure with more digits than a number holds exactly as text, region keys as text with their leading zeros, value symbols kept and named; with `language: en` the figures stay text, GENESIS's English number format being unverified). An empty answer says whether the code doesn't exist or the selection excluded everything. |
| `findStatistics` | A topic to object codes: GENESIS's full-text search over tables (default), statistics, cubes, time series and variables, with each table's regional depth (Kreise, Gemeinden); `complete` is false when a type's list reached `limit`. |
| `getFlatTable` | A table as GENESIS's flat CSV ("ffcsv": one row per value, every dimension a column), unpacked from the download's ZIP, as columns and rows a page at a time. The server writes no file. |
| `describeObject` | An object's title, regional depth, time span and dimensions (the variable codes `fetchData` filters by), from its metadata. |
| `browseCatalogue` | The tables, statistics, cubes, time series, variables or values whose code (or title) matches a pattern (`12411*`: a statistic's tables at every depth, `…-4` Kreise, `…-5` Gemeinden). |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (the endpoint and its parameters as GENESIS got them, trimmed and composed, whole, never the login; an answer a redirect
fetched from another host would say so there), the data licence and, where
GENESIS's answer has one, its own `copyright` (`getFlatTable`'s download has none). A
text over 2000 characters is cut and ends in `…[cut, N characters in all]`, and the answer says
`truncated`. An answer over `--max-result-chars` first loses entries from the end of its page (then
`nextOffset` says where to go on), then has its longest texts cut further (each with that mark) or,
when that isn't enough, its other lists shortened (`reason` names them); a list keeps its first
entry, `notes` stay whole, and the answer says `truncated`. One that can't be cut down so far is a
tool error that says to ask for less. A failure is a tool error that says what to change (one over
5000 characters loses its middle, never its end, where the reason is). A table too large for a
direct fetch is refused by GENESIS (status 98): narrow it, by region key first (a Gemeinde table
without one is huge; the error names the tool's own arguments: region key, years or class keys for
the data tools, the term or the code pattern and `limit` for a search or a catalogue); this server, like the CLI, doesn't run GENESIS's batch jobs. An HTTP 404 without a GENESIS
status (a moved path, a proxy) is a tool error saying the API's endpoint wasn't found, never "no
such table"; an HTTP 403 without one reads as blocked on the way (a proxy, a firewall, a rate
block), not as a refused login; a 502, 503 or 504 after the retries and a request timeout say
that GENESIS is sometimes slow or down and to try again shortly; nor is an answer whose shape this server doesn't know (a renamed key) ever "nothing
found": it is a tool error. A request GENESIS changed (its status 22, "erfolgreich mit
Parameteranpassung") keeps GENESIS's note as `statusNote` in every tool's answer, and a list it may
have shortened is not `complete`.

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
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **HTTP only with a bearer token** (see above): your GENESIS account must not become an open
  endpoint. It listens on loopback by default; it checks the `Host` header and, from a browser, the
  `Origin` (only the origins given with `--allowed-origins`, matched exactly) against DNS rebinding
  and other web pages; a page on one of those origins gets CORS (its preflight answered, the answers
  readable). Exposed beyond localhost (it logs a warning then), it belongs behind a TLS proxy.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time (the host ends
  requests beyond about 10 in parallel per account) and 120 a minute to the API, pauses the requests
  to a host that answers HTTP 429 (as long as its Retry-After asks, at most 30 s; those to another
  host go on), and stops a tool call after its deadline (a tool that has read part of its answer by
  then may answer with that part, and says so). A request those limits would hold longer than it or
  its call may wait is not sent: the call fails at once, naming the limit and when to ask again (and
  the log says so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi, zero-width, tag
  and other invisible characters removed, but an emoji keeps its joiners; a credential echoed with
  one inside is still replaced; a key that cleaning makes equal to another stays, as `name~2`), but
  it is still other people's text: a model can be told things in it. The server can't act on that
  (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool (never a credential).
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
