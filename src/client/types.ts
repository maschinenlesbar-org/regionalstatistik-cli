// Response types for the GENESIS REST API (version 2020) as served by the
// Regionaldatenbank Deutschland (www.regionalstatistik.de).
//
// GENESIS wraps every non-`helloworld` response in a common envelope
// (`Ident`/`Status`/`Parameter`/`Copyright`) with the payload under `List`
// (catalogue services) or `Object` (data/metadata services). We type the
// envelope and the well-exemplified catalogue/find *list items*, but keep the
// heterogeneous `Object` payloads of data/metadata as opaque JSON — their shape
// varies per method and the useful content (a delimited CSV table, a recursive
// dimension tree) is not worth modelling field-by-field.
//
// GOTCHA carried into the types: GENESIS encodes "boolean" and "count" fields as
// JSON *strings* ("true"/"false"/"9"/"-1"), so those are typed `string`, never
// `boolean`/`number`.

/** A JSON value of unknown shape. */
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * The logical outcome of a request. GENESIS returns HTTP 200 even for logical
 * errors; the real result lives here. `Code` is the machine-readable status
 * (0 = ok, 22 = ok-with-auto-correction, 90 = not found, 98 = too large,
 * 104 = empty result, ...); `Type` is "Information"/"Warnung"/"Fehler"
 * (or their English equivalents), so it is kept as a plain string.
 *
 * NOTE: authentication failures arrive as this same `{ Code, Content, Type }`
 * object at the *top level* of the body, with no envelope around it, paired
 * with a non-2xx HTTP status — `Code 15` on HTTP 401 ("Sie sind nicht
 * berechtigt ...") when no credentials were sent, `Code 2` on HTTP 404 for
 * wrong credentials. The engine maps both shapes (see engine.ts).
 */
export interface GenesisStatus {
  Code: number;
  Content: string;
  Type: string;
}

/** Fields common to every enveloped (non-helloworld) response. */
export interface GenesisEnvelope {
  Ident: { Service: string; Method: string };
  Status: GenesisStatus;
  /** Echo of the request parameters; credentials are masked as "********". */
  Parameter: JsonObject;
  /** Attribution string to surface verbatim — do not hardcode (see DATA_LICENSE.md). */
  Copyright: string;
}

// --- Catalogue / find list items ------------------------------------------------

/** `catalogue/tables` item. */
export interface TableItem {
  Code: string;
  Content: string;
  Time?: string;
}

/** `catalogue/cubes` and `catalogue/timeseries` share this shape. */
export interface CubeItem {
  Code: string;
  Content: string;
  State?: string;
  Time?: string;
  LatestUpdate?: string;
  Information?: string;
}

/** `catalogue/statistics` item. `Cubes` is a *stringified* count. */
export interface StatisticItem {
  Code: string;
  Content: string;
  Cubes?: string;
  Information?: string;
}

/** `catalogue/variables` and `catalogue/values` item. `Values` is a stringified count. */
export interface VariableItem {
  Code: string;
  Content: string;
  Type?: string;
  Values?: string;
  Information?: string;
}

/** `catalogue/jobs` item. */
export interface JobItem {
  Code?: string;
  Content: string;
  Date?: string;
  Time?: string;
  State?: string;
}

/** `catalogue/modifieddata` item. */
export interface ModifiedDataItem {
  Code: string;
  Content: string;
  Type?: string;
  Date?: string;
  Added?: string;
}

// --- Enveloped responses --------------------------------------------------------

/** A `catalogue/*` response: the envelope plus a homogeneous `List`. */
export type CatalogueResponse<TItem> = GenesisEnvelope & { List: TItem[] };

/**
 * A `find/find` response. Instead of a single `List` it carries parallel arrays,
 * one per object type; each is present only when that type was searched and may
 * be `null`.
 */
export type FindResponse = GenesisEnvelope & {
  Cubes?: CubeItem[] | null;
  Statistics?: StatisticItem[] | null;
  Tables?: TableItem[] | null;
  Timeseries?: CubeItem[] | null;
  Variables?: VariableItem[] | null;
};

/**
 * A thin view over a data/metadata `Object`. Only `Content` (for `data/table`,
 * the whole table as a ";"-delimited CSV string in German number format) is
 * commonly present and typed; everything else stays opaque.
 */
export interface DataObject {
  Content?: string;
  [key: string]: JsonValue | undefined;
}

/** A `data/*` response (table/cube/timeseries/result). `Object` is kept opaque. */
export type DataResponse = GenesisEnvelope & { Object: DataObject };

/** A `metadata/*` response. `Object` shape varies per method — kept opaque. */
export type MetadataResponse = GenesisEnvelope & { Object: JsonObject };

// --- helloworld (does NOT use the envelope) -------------------------------------

/**
 * `helloworld/whoami` — needs no auth; the ideal first connectivity check.
 * `User-IP` is optional: the live regionalstatistik.de endpoint returns only
 * `User-Agent`.
 */
export interface WhoamiResponse {
  "User-Agent": string;
  "User-IP"?: string;
}

/**
 * `helloworld/logincheck`. NOTE: `Status` here is a plain string, not the
 * {@link GenesisStatus} object used by every other endpoint.
 */
export interface LoginCheckResponse {
  Status: string;
  Username: string;
}
