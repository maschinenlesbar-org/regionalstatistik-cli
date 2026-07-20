// Strongly-typed parameter objects for the GENESIS endpoints. Every field is
// optional (credentials are injected separately by the client); omitted fields
// are simply not sent. Values are passed through to the query string as-is.
//
// The Regionaldatenbank's whole point is the regional dimension: on `data/*`
// requests, `regionalvariable` picks the regional level (e.g. KREISE, GEMEIN)
// and `regionalkey` selects the region(s) by their official key (AGS/ARS, `*`
// wildcard allowed — e.g. "08*" for everything in Baden-Württemberg).

/** Object types `find/find` can search. */
export type FindCategory = "all" | "tables" | "statistics" | "cubes" | "variables" | "time-series";

/** Parameters for `find/find`. */
export interface FindParams {
  term: string;
  category?: FindCategory;
  /** Max results (default 100, server max 25000). */
  pagelength?: number;
  language?: string;
}

/**
 * Shared parameters for the `catalogue/*` browse endpoints. `selection` filters
 * by object code and supports a `*` wildcard (e.g. `"12411*"`).
 */
export interface CatalogueParams {
  selection?: string;
  area?: string;
  searchcriterion?: "Code" | "Content";
  sortcriterion?: "Code" | "Content";
  type?: string;
  /** Max results (default 100, server max 25000). */
  pagelength?: number;
  language?: string;
}

/** Parameters for the `metadata/*` describe endpoints (`name` is passed separately). */
export interface MetadataParams {
  area?: string;
  language?: string;
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
  language?: string;
}

/** File-download output formats offered by the `data/*file` endpoints. */
export type DataFileFormat = "datencsv" | "csv" | "ffcsv" | "xlsx" | "html" | "genml";

/** Parameters for the `data/*file` download endpoints (returns a ZIP wrapper). */
export interface DataFileParams extends DataTableParams {
  /** Output format; defaults server-side to `datencsv`. */
  format?: DataFileFormat;
}
