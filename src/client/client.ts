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
// REGIONALSTATISTIK_PASSWORD env vars). Only `whoami()` works without
// credentials; registration (free) is at
// https://www.regionalstatistik.de/genesis/online.
//
//   const c = new RegionalstatistikClient({
//     username: process.env.REGIONALSTATISTIK_USERNAME,
//     password: process.env.REGIONALSTATISTIK_PASSWORD,
//   });
//   await c.find({ term: "Bevölkerung Kreise" });
//   await c.data.table("12411-01-01-4", { regionalkey: "08*", startyear: "2020" });

import { RequestEngine, type EngineOptions, type RawResponse } from "./engine.js";
import type { QueryParams } from "./query.js";
import type {
  CatalogueParams,
  DataFileParams,
  DataTableParams,
  FindParams,
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

/** Options for the Regionalstatistik client (engine options plus credentials). */
export interface RegionalstatistikClientOptions extends EngineOptions {
  /**
   * A personal API token. Sent in the `username` header field with no password.
   * Takes precedence over `username`/`password` if both are given.
   */
  token?: string;
  /** Account username (may be an email). Requires `password`. */
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

  private list<TItem>(method: string, params: CatalogueParams): Promise<CatalogueResponse<TItem>> {
    return this.e.postJson(`${API}/catalogue/${method}`, params as QueryParams, this.auth());
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

  private get(method: string, name: string, params: MetadataParams): Promise<MetadataResponse> {
    return this.e.postJson(`${API}/metadata/${method}`, { name, ...params } as QueryParams, this.auth());
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

  private json(method: string, name: string, params: DataTableParams): Promise<DataResponse> {
    return this.e.postJson(`${API}/data/${method}`, { name, ...params } as QueryParams, this.auth());
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

  private file(method: string, name: string, params: DataFileParams): Promise<RawResponse> {
    return this.e.postRaw(`${API}/data/${method}`, FILE_ACCEPT, { name, ...params } as QueryParams, this.auth());
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
  private readonly username: string | undefined;
  private readonly password: string | undefined;

  readonly catalogue: CatalogueGroup;
  readonly metadata: MetadataGroup;
  readonly data: DataGroup;

  constructor(options: RegionalstatistikClientOptions = {}) {
    const { token, username, password, ...engineOptions } = options;
    // Token mode collapses onto the `username` field with no password; otherwise
    // use the username/password pair. Blank values are treated as unset.
    const tok = token?.trim();
    if (tok) {
      this.username = tok;
      this.password = undefined;
    } else {
      this.username = username?.trim() || undefined;
      this.password = password?.trim() || undefined;
    }
    this.engine = new RequestEngine(engineOptions);

    const auth: AuthHeaders = () => this.authHeaders();
    this.catalogue = new CatalogueGroup(this.engine, auth);
    this.metadata = new MetadataGroup(this.engine, auth);
    this.data = new DataGroup(this.engine, auth);
  }

  /** The credential headers merged into every authenticated request. */
  private authHeaders(): Record<string, string> {
    if (!this.username) return {};
    return this.password
      ? { username: this.username, password: this.password }
      : { username: this.username };
  }

  /** `helloworld/whoami` — connectivity check; unauthenticated GET. */
  whoami(): Promise<WhoamiResponse> {
    return this.engine.getJson(`${API}/helloworld/whoami`);
  }

  /** `helloworld/logincheck` — validate the supplied credentials. */
  logincheck(language?: string): Promise<LoginCheckResponse> {
    return this.engine.postJson(`${API}/helloworld/logincheck`, { language }, this.authHeaders());
  }

  /** `find/find` — full-text search across object types. */
  find(params: FindParams): Promise<FindResponse> {
    return this.engine.postJson(`${API}/find/find`, { ...params } as QueryParams, this.authHeaders());
  }
}
