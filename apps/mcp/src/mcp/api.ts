// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts, credentials.ts, auth.ts: the kit, the same in every
// repository) import the client only through this file, under the names below; the names on the
// right are this client's. Per repository, like tools.ts: a client whose names or functions differ
// adapts here.
//
// The Regionaldatenbank (GENESIS) needs a personal account since May 2025: a token, or a username
// and password; it serves nothing to a guest. No login is bundled and
// none is taken from argv: `findCredentials` (the kit's hook, credentials.ts) takes it, at the first
// tool call, from REGIONALSTATISTIK_API_TOKEN or REGIONALSTATISTIK_USERNAME + REGIONALSTATISTIK_PASSWORD, else from the
// credentials file `regstat config set` writes. One login, never pieced together from two places;
// a token next to a username and password is refused rather than picked (the CLI lets the token win).
// Because the server calls GENESIS with that account, it serves HTTP only with a bearer token
// (`HTTP_NEEDS_AUTH_TOKEN`, auth.ts): a personal account must not become an open endpoint.

import { CredentialStore } from "@maschinenlesbar.org/regionalstatistik-client/internal/credentials";
import { credentialProblem, DEFAULT_BASE_URL, RegionalstatistikValidationError } from "@maschinenlesbar.org/regionalstatistik-client";
import type { CredentialContext, FoundCredentials } from "./credentials.js";

export {
  RegionalstatistikClient as Client,
  RegionalstatistikError as ClientError,
  RegionalstatistikNetworkError as NetworkError,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/regionalstatistik-client";
export { sizeLimitMessage } from "@maschinenlesbar.org/regionalstatistik-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/regionalstatistik-client/internal/errors";

/** The REST API's path under the host: every endpoint is below it (lowercase `genesisws`: the uppercase path 404s on this host). */
export const API_PATH = "/genesisws/rest/2020";

/** The API's base URL as a result's `source` starts with it (`--base-url`, else the default, and the API's path). */
export function apiBase(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}${API_PATH}`;
}

/** The server calls GENESIS with a personal account: HTTP only with a bearer token (auth.ts). */
export const HTTP_NEEDS_AUTH_TOKEN = true;

/** The variables the login comes from, as the CLI reads them. */
export const LOGIN_ENV_VARS = { token: "REGIONALSTATISTIK_API_TOKEN", username: "REGIONALSTATISTIK_USERNAME", password: "REGIONALSTATISTIK_PASSWORD" } as const;

type LoginField = keyof typeof LOGIN_ENV_VARS;

/** How to give the server a login, for the messages. */
const HOW =
  "Set REGIONALSTATISTIK_API_TOKEN, or REGIONALSTATISTIK_USERNAME and REGIONALSTATISTIK_PASSWORD, in the server's environment (the MCP client's config for this server), " +
  "or store the login once with `regstat config set token` (or `username` and `password`). A free account: https://www.regionalstatistik.de/genesis/online. " +
  "The server takes no login on its command line; restart it after changing the login.";

/**
 * The GENESIS login, in this order: the REGIONALSTATISTIK_* variables of the server's environment (what an
 * MCP client's config sets), else the credentials file (`regstat config`; only when the server runs
 * from its bin). Either source is used whole: a token, or a username and password, never both and
 * never half a pair, and never one field from each place. A value no header can carry is an error
 * naming where it came from, never the value. Passwords are used exactly as given (not trimmed).
 * Every value is a secret of the server from here on.
 */
export async function findCredentials(context: CredentialContext): Promise<FoundCredentials> {
  const nonBlank = (value: string | undefined): string | undefined => (value !== undefined && value.trim() !== "" ? value : undefined);
  const fromEnv: Partial<Record<LoginField, string>> = {};
  for (const field of Object.keys(LOGIN_ENV_VARS) as LoginField[]) {
    const value = nonBlank(context.env[LOGIN_ENV_VARS[field]]);
    if (value !== undefined) fromEnv[field] = value;
  }
  if (Object.keys(fromEnv).length > 0) {
    return login(fromEnv, (field) => LOGIN_ENV_VARS[field], "the server's environment", (fields) => `from ${fields.map((field) => LOGIN_ENV_VARS[field]).join(" and ")}`);
  }
  if (context.credentialsFile) {
    const store = CredentialStore.fromEnv(context.env);
    const all = store.all();
    const stored: Partial<Record<LoginField, string>> = {};
    for (const field of Object.keys(LOGIN_ENV_VARS) as LoginField[]) {
      const value = nonBlank(all[field]);
      if (value !== undefined) stored[field] = value;
    }
    if (Object.keys(stored).length > 0) {
      return login(stored, (field) => `the stored ${field} (${store.path})`, `the credentials file ${store.path}`, () => `stored in ${store.path} (regstat config)`, store.path);
    }
  }
  throw new RegionalstatistikValidationError(`No GENESIS login. ${HOW}`);
}

/** One login from one place, checked; `name` says where a field came from, never its value. */
function login(
  found: Partial<Record<LoginField, string>>,
  name: (field: LoginField) => string,
  place: string,
  where: (fields: LoginField[]) => string,
  storePath?: string,
): FoundCredentials {
  for (const field of Object.keys(found) as LoginField[]) {
    const reason = credentialProblem(found[field] as string);
    if (reason !== undefined) {
      const fix = storePath === undefined ? `Fix ${LOGIN_ENV_VARS[field]}.` : `Replace it: regstat config set ${field}`;
      throw new RegionalstatistikValidationError(`${name(field)} cannot be sent: ${reason.replace(/^Value\s*/, "")} ${fix}`.replace(/\s+/g, " "));
    }
  }
  const { token, username, password } = found;
  if (token !== undefined && (username !== undefined || password !== undefined)) {
    throw new RegionalstatistikValidationError(
      `${place} gives a token and a username/password: one login only. ${storePath === undefined ? "Unset REGIONALSTATISTIK_API_TOKEN, or REGIONALSTATISTIK_USERNAME and REGIONALSTATISTIK_PASSWORD." : "Remove the one you don't use: regstat config unset token (or username and password)."}`,
    );
  }
  if (token !== undefined) return { clientOptions: { token }, secrets: [token], source: `the GENESIS token ${where(["token"])}` };
  if (username === undefined || password === undefined) {
    const missing: LoginField = username === undefined ? "username" : "password";
    throw new RegionalstatistikValidationError(
      `${place} gives a ${missing === "username" ? "password" : "username"} but no ${missing}: a login is a username and a password, or a token. ` +
        (storePath === undefined ? `Set ${LOGIN_ENV_VARS[missing]} too.` : `Store it: regstat config set ${missing}`) +
        (storePath === undefined ? " (The credentials file is not read while a REGIONALSTATISTIK_* variable is set.)" : ""),
    );
  }
  return {
    clientOptions: { username, password },
    secrets: [username, password],
    source: `the GENESIS username and password ${where(["username", "password"])}`,
  };
}
