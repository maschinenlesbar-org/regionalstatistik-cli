// Strongly-typed parameter objects for the GENESIS endpoints. Every field is
// optional (credentials are injected separately by the client); omitted fields
// are simply not sent. The client checks the given values before any request
// (see validate.ts): a blank string (empty or whitespace only) is rejected with
// RegionalstatistikValidationError, since GENESIS reads an empty parameter as
// "no filter". The enumerated parameters (language, category, the criteria,
// format) must be one of the values exported below; pagelength is an integer
// from 1 to MAX_PAGELENGTH and timeslices a non-negative integer. Valid values
// are sent as-is, never trimmed.
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
  category?: FindCategory;
  /** Max results: an integer from 1 to `MAX_PAGELENGTH` (server default 100). */
  pagelength?: number;
  language?: Language;
}

/**
 * Shared parameters for the `catalogue/*` browse endpoints. `selection` filters
 * by object code and supports a `*` wildcard (e.g. `"12411*"`).
 */
export interface CatalogueParams {
  selection?: string;
  area?: string;
  searchcriterion?: Criterion;
  sortcriterion?: Criterion;
  type?: string;
  /** Max results: an integer from 1 to `MAX_PAGELENGTH` (server default 100). */
  pagelength?: number;
  language?: Language;
}

/** Parameters for the `metadata/*` describe endpoints (`name` is passed separately). */
export interface MetadataParams {
  area?: string;
  language?: Language;
}

/**
 * Parameters for `data/table` (the workhorse). Selection is narrowed with the
 * year/time, regional and classifying-variable filters; GENESIS returns the
 * table as a delimited CSV string in `Object.Content`.
 */
export interface DataTableParams {
  area?: string;
  /** Include the recursive dimension tree under `Object.Structure`. */
  structureinformation?: boolean;
  compress?: boolean;
  transpose?: boolean;
  contents?: string;
  startyear?: string;
  endyear?: string;
  /** Number of time slices from the end: a non-negative integer. */
  timeslices?: number;
  /** Regional level variable, e.g. KREISE (Kreise) or GEMEIN (Gemeinden). */
  regionalvariable?: string;
  /** Regional key selection (AGS/ARS), `*` wildcard allowed (e.g. "08*"). */
  regionalkey?: string;
  classifyingvariable1?: string;
  classifyingkey1?: string;
  classifyingvariable2?: string;
  classifyingkey2?: string;
  classifyingvariable3?: string;
  classifyingkey3?: string;
  classifyingvariable4?: string;
  classifyingkey4?: string;
  classifyingvariable5?: string;
  classifyingkey5?: string;
  stand?: string;
  language?: Language;
}

/** File-download output formats offered by the `data/*file` endpoints (`format`). */
export const DATA_FILE_FORMATS = ["datencsv", "csv", "ffcsv", "xlsx", "html", "genml"] as const;
/** A file-download output format. */
export type DataFileFormat = (typeof DATA_FILE_FORMATS)[number];

/** Parameters for the `data/*file` download endpoints (returns a ZIP wrapper). */
export interface DataFileParams extends DataTableParams {
  /** Output format; defaults server-side to `datencsv`. */
  format?: DataFileFormat;
}
