// Strongly-typed parameter objects for the GENESIS endpoints. Every field is
// optional (credentials are injected separately by the client); omitted fields
// are simply not sent. The client checks the given values before any request
// (see validate.ts): a blank string (empty or whitespace only) is rejected with
// RegionalstatistikValidationError, since GENESIS reads an empty parameter as
// "no filter". The enumerated parameters (language, category, the criteria,
// format) must be one of the values exported below; pagelength is an integer
// from 1 to MAX_PAGELENGTH and timeslices a non-negative integer. Valid values
// are sent as-is, never trimmed — only normalised to Unicode NFC, which GENESIS
// matches.
//
// The Regionaldatenbank's whole point is the regional dimension: on `data/*`
// requests, `regionalvariable` picks the regional level (e.g. KREISE, GEMEIN)
// and `regionalkey` selects the region(s) by their official key (AGS/ARS, `*`
// wildcard allowed — e.g. "08*" for everything in Baden-Württemberg).

/** Most results a list request may ask for (`pagelength`, the server's maximum). */
export const MAX_PAGELENGTH = 25000;

/** Response languages GENESIS offers (`language`). */
export const LANGUAGES = ["de", "en"] as const;
/** A response language (`language`). */
export type Language = (typeof LANGUAGES)[number];

/** Object types `find/find` can search (`category`). */
export const FIND_CATEGORIES = ["all", "tables", "statistics", "cubes", "variables", "time-series"] as const;
/** Object types `find/find` can search. */
export type FindCategory = (typeof FIND_CATEGORIES)[number];

/** Fields a catalogue `selection` matches and sorts by (`searchcriterion`, `sortcriterion`). */
export const CRITERIA = ["Code", "Content"] as const;
/** A catalogue search or sort criterion. */
export type Criterion = (typeof CRITERIA)[number];

/** Parameters for `find/find`. */
export interface FindParams {
  term: string;
  category?: FindCategory | undefined;
  /** Max results: an integer from 1 to `MAX_PAGELENGTH` (server default 100). */
  pagelength?: number | undefined;
  language?: Language | undefined;
}

/**
 * Shared parameters for the `catalogue/*` browse endpoints. `selection` filters
 * by object code and supports a `*` wildcard (e.g. `"12411*"`).
 */
export interface CatalogueParams {
  selection?: string | undefined;
  area?: string | undefined;
  searchcriterion?: Criterion | undefined;
  sortcriterion?: Criterion | undefined;
  type?: string | undefined;
  /** Max results: an integer from 1 to `MAX_PAGELENGTH` (server default 100). */
  pagelength?: number | undefined;
  language?: Language | undefined;
}

/** Parameters for the `metadata/*` describe endpoints (`name` is passed separately). */
export interface MetadataParams {
  area?: string | undefined;
  language?: Language | undefined;
}

/**
 * Parameters for `data/table` (the workhorse). Selection is narrowed with the
 * year/time, regional and classifying-variable filters; GENESIS returns the
 * table as a delimited CSV string in `Object.Content`.
 */
export interface DataTableParams {
  area?: string | undefined;
  /** Include the recursive dimension tree under `Object.Structure`. */
  structureinformation?: boolean | undefined;
  compress?: boolean | undefined;
  transpose?: boolean | undefined;
  contents?: string | undefined;
  startyear?: string | undefined;
  endyear?: string | undefined;
  /** Number of time slices from the end: a non-negative integer. */
  timeslices?: number | undefined;
  /** Regional level variable, e.g. KREISE (Kreise) or GEMEIN (Gemeinden). */
  regionalvariable?: string | undefined;
  /** Regional key selection (AGS/ARS), `*` wildcard allowed (e.g. "08*"). */
  regionalkey?: string | undefined;
  classifyingvariable1?: string | undefined;
  classifyingkey1?: string | undefined;
  classifyingvariable2?: string | undefined;
  classifyingkey2?: string | undefined;
  classifyingvariable3?: string | undefined;
  classifyingkey3?: string | undefined;
  classifyingvariable4?: string | undefined;
  classifyingkey4?: string | undefined;
  classifyingvariable5?: string | undefined;
  classifyingkey5?: string | undefined;
  stand?: string | undefined;
  language?: Language | undefined;
}

/** File-download output formats offered by the `data/*file` endpoints (`format`). */
export const DATA_FILE_FORMATS = ["datencsv", "csv", "ffcsv", "xlsx", "html", "genml"] as const;
/** A file-download output format. */
export type DataFileFormat = (typeof DATA_FILE_FORMATS)[number];

/** Parameters for the `data/*file` download endpoints (returns a ZIP wrapper). */
export interface DataFileParams extends DataTableParams {
  /** Output format; defaults server-side to `datencsv`. */
  format?: DataFileFormat | undefined;
}

// --- The parameter keys each endpoint takes (P10) -------------------------------
// GENESIS ignores a parameter it does not know: a misspelt `startYear` (for
// `startyear`) or `selction` answers with the whole unfiltered result and HTTP 200. So
// the client rejects any other key before the request, unless the call passes
// `{ allowUnknownParams: true }` (for a parameter GENESIS adds after these lists were
// written). The lists follow the interfaces above.

/** `find/find` parameter keys. */
export const FIND_PARAM_KEYS = ["term", "category", "pagelength", "language"] as const;
/** `catalogue/*` parameter keys. */
export const CATALOGUE_PARAM_KEYS = ["selection", "area", "searchcriterion", "sortcriterion", "type", "pagelength", "language"] as const;
/** `metadata/*` parameter keys (the object `name` is passed separately). */
export const METADATA_PARAM_KEYS = ["area", "language"] as const;
/** `data/*` parameter keys (the object `name` is passed separately). */
export const DATA_PARAM_KEYS = [
  "area",
  "structureinformation",
  "compress",
  "transpose",
  "contents",
  "startyear",
  "endyear",
  "timeslices",
  "regionalvariable",
  "regionalkey",
  "classifyingvariable1",
  "classifyingkey1",
  "classifyingvariable2",
  "classifyingkey2",
  "classifyingvariable3",
  "classifyingkey3",
  "classifyingvariable4",
  "classifyingkey4",
  "classifyingvariable5",
  "classifyingkey5",
  "stand",
  "language",
] as const;
/** `data/*file` parameter keys: the `data/*` ones plus `format`. */
export const DATA_FILE_PARAM_KEYS = [...DATA_PARAM_KEYS, "format"] as const;

/** Parameters GENESIS takes as `true`/`false` (sent as those strings). */
export const BOOLEAN_PARAM_KEYS = ["structureinformation", "compress", "transpose"] as const;

/** Options for a client call that takes a parameter object. */
export interface ParamOptions {
  /**
   * Send parameter keys that are not in the endpoint's list (`FIND_PARAM_KEYS`, …),
   * for a parameter GENESIS added after the list was written. Default `false`: an
   * unknown key is rejected, because GENESIS ignores it and answers unfiltered. The
   * value must still be a string, number or boolean, and `__proto__`, `constructor`
   * and `prototype` are never accepted.
   */
  allowUnknownParams?: boolean | undefined;
}
