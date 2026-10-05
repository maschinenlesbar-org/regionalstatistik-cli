// RegionalstatistikClient — a typed client over the Regionaldatenbank
// Deutschland's GENESIS REST API
// (https://www.regionalstatistik.de/genesisws/rest/2020), the regional
// official-statistics database run by the statistical offices of the Bund and
// the Länder. NOTE the lowercase `genesisws` in the path — unlike DESTATIS'
// `/genesisWS/...`, the uppercase variant 404s on this host.
//
// Auth: GENESIS has no Bearer/X-API-Key header. Authenticated calls are POST with
// the credentials in HTTP header fields — EITHER a personal API token in the
// `username` header (no password) OR a `username`+`password` pair — and the
// request parameters in a form-urlencoded body. No credential is bundled; pass
// them via the options below (CLI: --token / --username+--password, or the
// REGIONALSTATISTIK_API_TOKEN / REGIONALSTATISTIK_USERNAME /
// REGIONALSTATISTIK_PASSWORD env vars). `whoami()` needs no credentials, and
// `logincheck()` works without them too (GENESIS answers as the guest user
// "GAST"); `find`, catalogue, metadata and data need an account and reject with
// `RegionalstatistikValidationError` before any request when the client has
// none. Registration (free) is at https://www.regionalstatistik.de/genesis/online.
//
//   const c = new RegionalstatistikClient({
//     username: process.env.REGIONALSTATISTIK_USERNAME,
//     password: process.env.REGIONALSTATISTIK_PASSWORD,
//   });
//   await c.find({ term: "Bevölkerung Kreise" });
//   await c.data.table("12411-01-01-4", { regionalkey: "08*", startyear: "2020" });

import { RequestEngine, type EngineOptions, type RawResponse, type ResponseShape } from "./engine.js";
import type { QueryParams } from "./query.js";
import {
  assertRequestParams,
  assertValid,
  credentialPairProblem,
  credentialProblem,
  credentialsRequiredProblem,
  nonBlankProblem,
  plainObjectProblem,
} from "./validate.js";
import type {
  CatalogueParams,
  DataFileParams,
  DataTableParams,
  FindParams,
  Language,
  MetadataParams,
} from "./params.js";
import type {
  CatalogueResponse,
  CubeItem,
  DataResponse,
  FindResponse,
  JobItem,
  LoginCheckResponse,
  MetadataResponse,
  ModifiedDataItem,
  StatisticItem,
  TableItem,
  VariableItem,
  WhoamiResponse,
} from "./types.js";

// Lowercase `genesisws` is load-bearing on www.regionalstatistik.de: the
// uppercase `/genesisWS/...` path returns an HTML 404 page on this host.
const API = "/genesisws/rest/2020";

/** Accept header for the file-download endpoints (GENESIS returns a ZIP wrapper). */
const FILE_ACCEPT = "application/zip, */*";

/** A supplier of the per-request credential headers (username / optional password). */
type AuthHeaders = () => Record<string, string>;

/**
 * Validate a request's parameters (see `validate.ts`) and POST them, parsing the
 * JSON reply. `async`, so a rejected input rejects the promise — and sends nothing.
 */
async function postJson<T>(
  e: RequestEngine,
  path: string,
  params: QueryParams,
  auth: AuthHeaders,
  shape: ResponseShape = "envelope",
): Promise<T> {
  assertRequestParams(params);
  return e.postJson<T>(path, params, auth(), shape);
}

/**
 * A method's parameter object, checked: `undefined` is none, anything else must be a
 * plain object (`RegionalstatistikValidationError` otherwise — a string would be spread into
 * `0=x`, `null` into nothing).
 */
function paramsOf(params: unknown): QueryParams {
  if (params === undefined) return {};
  assertValid("params", params, plainObjectProblem);
  return { ...(params as object) } as QueryParams;
}

/** Validate a request object's required `name` (the object code) and its parameters. */
function named(name: string, params: unknown): QueryParams {
  assertValid("name", name, nonBlankProblem);
  return { name, ...paramsOf(params) } as QueryParams;
}

/** Options for the Regionalstatistik client (engine options plus credentials). */
export interface RegionalstatistikClientOptions extends EngineOptions {
  /**
   * A personal API token. Sent in the `username` header field with no password.
   * Takes precedence over `username`/`password` if both are given.
   */
  token?: string;
  /**
   * Account username (may be an email). Requires `password`: with only one of the
   * two (and no token) the constructor throws `RegionalstatistikValidationError`.
   */
  username?: string;
  /** Account password. */
  password?: string;
}

/** `catalogue/*` browse endpoints — each returns an enveloped `List`. */
class CatalogueGroup {
  constructor(
    private readonly e: RequestEngine,
    private readonly auth: AuthHeaders,
  ) {}

  private async list<TItem>(method: string, params: CatalogueParams): Promise<CatalogueResponse<TItem>> {
    return postJson(this.e, `${API}/catalogue/${method}`, paramsOf(params), this.auth);
  }

  tables(params: CatalogueParams = {}): Promise<CatalogueResponse<TableItem>> {
    return this.list("tables", params);
  }
  statistics(params: CatalogueParams = {}): Promise<CatalogueResponse<StatisticItem>> {
    return this.list("statistics", params);
  }
  cubes(params: CatalogueParams = {}): Promise<CatalogueResponse<CubeItem>> {
    return this.list("cubes", params);
  }
  timeseries(params: CatalogueParams = {}): Promise<CatalogueResponse<CubeItem>> {
    return this.list("timeseries", params);
  }
  variables(params: CatalogueParams = {}): Promise<CatalogueResponse<VariableItem>> {
    return this.list("variables", params);
  }
  values(params: CatalogueParams = {}): Promise<CatalogueResponse<VariableItem>> {
    return this.list("values", params);
  }
  terms(params: CatalogueParams = {}): Promise<CatalogueResponse<TableItem>> {
    return this.list("terms", params);
  }
  jobs(params: CatalogueParams = {}): Promise<CatalogueResponse<JobItem>> {
    return this.list("jobs", params);
  }
  modifiedData(params: CatalogueParams = {}): Promise<CatalogueResponse<ModifiedDataItem>> {
    return this.list("modifieddata", params);
  }
  results(params: CatalogueParams = {}): Promise<CatalogueResponse<TableItem>> {
    return this.list("results", params);
  }
  qualitySigns(params: CatalogueParams = {}): Promise<CatalogueResponse<TableItem>> {
    return this.list("qualitysigns", params);
  }
}

/** `metadata/*` describe endpoints — each returns a single opaque `Object`. */
class MetadataGroup {
  constructor(
    private readonly e: RequestEngine,
    private readonly auth: AuthHeaders,
  ) {}

  private async get(method: string, name: string, params: MetadataParams): Promise<MetadataResponse> {
    return postJson(this.e, `${API}/metadata/${method}`, named(name, params), this.auth);
  }

  table(name: string, params: MetadataParams = {}): Promise<MetadataResponse> {
    return this.get("table", name, params);
  }
  statistic(name: string, params: MetadataParams = {}): Promise<MetadataResponse> {
    return this.get("statistic", name, params);
  }
  cube(name: string, params: MetadataParams = {}): Promise<MetadataResponse> {
    return this.get("cube", name, params);
  }
  timeseries(name: string, params: MetadataParams = {}): Promise<MetadataResponse> {
    return this.get("timeseries", name, params);
  }
  variable(name: string, params: MetadataParams = {}): Promise<MetadataResponse> {
    return this.get("variable", name, params);
  }
  value(name: string, params: MetadataParams = {}): Promise<MetadataResponse> {
    return this.get("value", name, params);
  }
}

/** `data/*` endpoints — statistical data as JSON-embedded CSV, or file downloads. */
class DataGroup {
  constructor(
    private readonly e: RequestEngine,
    private readonly auth: AuthHeaders,
  ) {}

  private async json(method: string, name: string, params: DataTableParams): Promise<DataResponse> {
    return postJson(this.e, `${API}/data/${method}`, named(name, params), this.auth);
  }

  table(name: string, params: DataTableParams = {}): Promise<DataResponse> {
    return this.json("table", name, params);
  }
  cube(name: string, params: DataTableParams = {}): Promise<DataResponse> {
    return this.json("cube", name, params);
  }
  timeseries(name: string, params: DataTableParams = {}): Promise<DataResponse> {
    return this.json("timeseries", name, params);
  }
  result(name: string, params: DataTableParams = {}): Promise<DataResponse> {
    return this.json("result", name, params);
  }

  private async file(method: string, name: string, params: DataFileParams): Promise<RawResponse> {
    const all = named(name, params);
    assertRequestParams(all);
    return this.e.postRaw(`${API}/data/${method}`, FILE_ACCEPT, all, this.auth());
  }
  tableFile(name: string, params: DataFileParams = {}): Promise<RawResponse> {
    return this.file("tablefile", name, params);
  }
  cubeFile(name: string, params: DataFileParams = {}): Promise<RawResponse> {
    return this.file("cubefile", name, params);
  }
  timeseriesFile(name: string, params: DataFileParams = {}): Promise<RawResponse> {
    return this.file("timeseriesfile", name, params);
  }
  resultFile(name: string, params: DataFileParams = {}): Promise<RawResponse> {
    return this.file("resultfile", name, params);
  }
}

export class RegionalstatistikClient {
  private readonly engine: RequestEngine;
  // Real private fields (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show them, so logging a client can't reveal the
  // token or password.
  readonly #username: string | undefined;
  readonly #password: string | undefined;

  readonly catalogue: CatalogueGroup;
  readonly metadata: MetadataGroup;
  readonly data: DataGroup;

  constructor(options: RegionalstatistikClientOptions = {}) {
    assertValid("options", options, plainObjectProblem);
    const { token, username, password, ...engineOptions } = options;
    // Token mode collapses onto the `username` field with no password; otherwise
    // use the username/password pair. Blank (empty or whitespace-only) values are
    // treated as unset (so `token: process.env.REGIONALSTATISTIK_API_TOKEN` works when the
    // variable is empty); any other value must be a valid credential header value
    // (`credentialProblem`: no control characters, nothing above U+00FF, no
    // surrounding whitespace) and is sent exactly as given, never trimmed.
    // A non-string (a JavaScript caller's number or null) is a RegionalstatistikValidationError,
    // not a raw TypeError from `.trim()`.
    const set = (name: string, v: unknown): string | undefined =>
      v === undefined || (typeof v === "string" && v.trim() === "") ? undefined : assertValid(name, v as string, credentialProblem);
    const tok = set("token", token);
    if (tok) {
      this.#username = tok;
      this.#password = undefined;
    } else {
      this.#username = set("username", username);
      this.#password = set("password", password);
      assertValid("credentials", { username: this.#username, password: this.#password }, credentialPairProblem);
    }
    this.engine = new RequestEngine(engineOptions);

    // catalogue, metadata and data are account-only endpoints.
    const auth: AuthHeaders = () => this.requireAuth();
    this.catalogue = new CatalogueGroup(this.engine, auth);
    this.metadata = new MetadataGroup(this.engine, auth);
    this.data = new DataGroup(this.engine, auth);
  }

  /**
   * The credential headers for an account-only endpoint. Without credentials
   * GENESIS would answer 401 + Code 15 after the round trip, so this throws
   * `RegionalstatistikValidationError` (`Invalid credentials: …`) before any request.
   */
  private requireAuth(): Record<string, string> {
    assertValid("credentials", { username: this.#username }, credentialsRequiredProblem);
    return this.authHeaders();
  }

  /** The credential headers merged into every request that takes them (none when unset). */
  private authHeaders(): Record<string, string> {
    if (!this.#username) return {};
    return this.#password
      ? { username: this.#username, password: this.#password }
      : { username: this.#username };
  }

  /** `helloworld/whoami` — connectivity check; unauthenticated GET. */
  whoami(): Promise<WhoamiResponse> {
    return this.engine.getJson(`${API}/helloworld/whoami`);
  }

  /**
   * `helloworld/logincheck` — validate the supplied credentials. Without any,
   * GENESIS answers as the guest user (`"Username": "GAST"`), so this does not
   * demand credentials.
   */
  logincheck(language?: Language): Promise<LoginCheckResponse> {
    return postJson(this.engine, `${API}/helloworld/logincheck`, { language }, () => this.authHeaders(), "unchecked");
  }

  /**
   * `find/find` — full-text search across object types. `term` must be non-blank;
   * needs an account (rejects with `RegionalstatistikValidationError` without one).
   */
  async find(params: FindParams): Promise<FindResponse> {
    assertValid("params", params, plainObjectProblem);
    assertValid("term", params.term, nonBlankProblem);
    return postJson(this.engine, `${API}/find/find`, paramsOf(params), () => this.requireAuth());
  }
}
