// The use cases of the skills as library functions, built on the client: each composes the
// client's calls and carries the traps the skills document, so no caller (the CLI, the MCP
// server's use-case tools, a library user) has to know them.
// - fetchData: the numbers of a table, cube, time series or saved result, narrowed, with the
//   ";"-delimited German-format CSV in `Object.Content` decoded (regionalstatistik-data-fetch);
// - findStatistics: a topic to object codes, from the full-text search (regionalstatistik-statistics-finder);
// - describeObject: an object's dimensions and time span (metadata), to check a code before
//   fetching (regionalstatistik-statistics-finder);
// - getFlatTable: the flat, spreadsheet-ready CSV ("ffcsv") a download holds, unpacked from its
//   ZIP, as columns and rows (regionalstatistik-table-download);
// - browseCatalogue: the objects whose code matches a pattern ("12411*").
//
// The Regionaldatenbank runs the GENESIS software of GENESIS-Online (destatis-genesis-cli has the
// same operations); what differs here is the regional dimension: a region key (AGS, 08221 for
// Heidelberg, `08*` for Baden-Württemberg's Kreise) narrows a request on its own, the table's
// regional depth is part of its code and title (…-4 Kreise, …-5 Gemeinden), and region keys with
// a leading zero must stay text.
//
// Traps that hold for all of them: HTTP 200 is not success (the client maps GENESIS's Status);
// "nothing matched" is a valid answer, not an error, and comes in three shapes (`find`: every
// list null; a catalogue: Status 104 with an empty list; data and metadata: Status 104 without an
// Object), so each is `empty` here, with what was searched and what to change; a wrong code is not
// an error either, so an empty data answer is checked against the catalogue (which lists the code
// when it exists) to tell "no such code" from "the filters excluded everything"; codes are exact (no wildcard) except in a
// catalogue; counts come as strings ("9") and are numbers here.

import type { RegionalstatistikClient } from "./client.js";
import { RegionalstatistikApiError, RegionalstatistikParseError, RegionalstatistikValidationError } from "./errors.js";
import type { CatalogueParams, DataFileParams, DataTableParams, FindCategory, Language } from "./params.js";
import type { GenesisEnvelope, JsonObject, JsonValue } from "./types.js";
import { assertValid, normalizeText, normalizeToken, textProblem, tokenProblem } from "./validate.js";
import { isZip, zipEntries } from "./zip.js";

/** What every operation answers: ok, or empty (with the reason). */
export type OperationStatus = "ok" | "empty";

// --- Shared ----------------------------------------------------------------------------------

/** The objects whose data can be fetched. */
export const DATA_KINDS = ["table", "cube", "timeseries", "result"] as const;
export type DataKind = (typeof DATA_KINDS)[number];

/** The objects metadata describes. */
export const METADATA_KINDS = ["table", "statistic", "cube", "timeseries", "variable", "value"] as const;
export type MetadataKind = (typeof METADATA_KINDS)[number];

/** The catalogues browsed by code. */
export const CATALOGUE_KINDS = ["tables", "statistics", "cubes", "timeseries", "variables", "values"] as const;
export type CatalogueKind = (typeof CATALOGUE_KINDS)[number];

/** One classifying variable and the values (keys) to keep, comma-separated, `*` allowed. */
export interface ClassFilter {
  variable: string;
  key?: string | undefined;
}

/** How a data request is narrowed (each maps to a GENESIS parameter). */
export interface DataSelection {
  /** From this year (`startyear`). */
  startYear?: string | undefined;
  /** Up to this year (`endyear`). */
  endYear?: string | undefined;
  /** Only the latest N periods (`timeslices`). */
  timeslices?: number | undefined;
  /**
   * The regional level (`regionalvariable`: KREISE, GEMEIN, DLAND, …), usually not needed when the
   * table's depth matches, and the regions by their official key (`regionalkey`, AGS/ARS: 08221 is
   * Stadtkreis Heidelberg, 08* every Kreis in Baden-Württemberg; comma-separated, `*` allowed).
   */
  regionVariable?: string | undefined;
  regionKey?: string | undefined;
  /** Up to five classifying variables with their keys (`classifyingvariable1..5`, `classifyingkey1..5`). */
  classes?: readonly ClassFilter[] | undefined;
  /** Only these value columns (`contents`, comma-separated codes). */
  contents?: string | undefined;
  language?: Language | undefined;
}

/** The selection as an answer echoes it (`searched`): only what was given. */
export type Searched = Record<string, string | number>;

/** The GENESIS status of an answer that is not plain success (22, a corrected parameter): kept, never dropped. */
export interface StatusNote {
  code: number;
  text: string;
}

/** A code, checked: no wildcard (the data and metadata endpoints take exact codes only). */
function exactCode(code: string, kind: string): string {
  const checked = normalizeToken(assertValid("code", code, tokenProblem));
  if (checked.includes("*")) {
    throw new RegionalstatistikValidationError(
      `Invalid code: ${kind} codes are exact (like 12411-01-01-4), "*" works in a catalogue only: browse the codes that match a pattern there first.`,
    );
  }
  return checked;
}

/** The selection as GENESIS parameters, and as the answer echoes it. */
function selectionParams(selection: DataSelection): { params: DataTableParams; searched: Searched } {
  const params: DataTableParams = {};
  const searched: Searched = {};
  const set = (key: keyof DataTableParams, name: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    (params as Record<string, unknown>)[key] = value;
    searched[name] = value;
  };
  set("startyear", "startYear", selection.startYear);
  set("endyear", "endYear", selection.endYear);
  set("timeslices", "timeslices", selection.timeslices);
  set("regionalvariable", "regionVariable", selection.regionVariable);
  set("regionalkey", "regionKey", selection.regionKey);
  const classes = selection.classes ?? [];
  if (classes.length > 5) throw new RegionalstatistikValidationError("Invalid classes: GENESIS takes at most five classifying variables.");
  classes.forEach((filter, i) => {
    const n = i + 1;
    set(`classifyingvariable${n}` as keyof DataTableParams, `classVariable${n}`, filter.variable);
    set(`classifyingkey${n}` as keyof DataTableParams, `classKey${n}`, filter.key);
  });
  set("contents", "contents", selection.contents);
  if (selection.language !== undefined) params.language = selection.language;
  return { params, searched };
}

/** The status of an answer that is not plain success (0), for the caller to see. */
function statusNote(answer: GenesisEnvelope): StatusNote | undefined {
  const code = answer.Status?.Code;
  return code === undefined || code === 0 ? undefined : { code, text: answer.Status.Content };
}

/** True for GENESIS's "nothing matched" (Status 104). */
function isEmpty(answer: GenesisEnvelope): boolean {
  return answer.Status?.Code === 104;
}

/**
 * True for GENESIS's own "no such object": status 90 (object not found), or 104 on a download. Not
 * for an HTTP 404 without a GENESIS status (`isNotFound` counts one, for the CLI's exit code): that
 * is a moved path or a proxy page, the endpoint not found rather than the object, and stays the
 * client's error; nor for a refused login (this host sends one as HTTP 404 with code 2).
 */
function noSuchObject(err: unknown): err is RegionalstatistikApiError {
  return err instanceof RegionalstatistikApiError && !err.isAuthError && (err.code === 90 || err.code === 104);
}

/**
 * An answer that isn't "nothing matched" (104) but lacks a key every success of its endpoint has
 * (`Tables` and the other lists of a search, `Object.Content` of data, a table's `Structure`, a
 * catalogue's `List`): a shape this client doesn't know, so an error, never read as "nothing".
 * The shapes come from GENESIS's documentation; a renamed key would otherwise make every answer a
 * confident "no hits" or "the selection excluded everything".
 */
function unexpectedShape(endpoint: string, missing: string): RegionalstatistikParseError {
  return new RegionalstatistikParseError(`GENESIS's answer to ${endpoint} has no ${missing}: a shape this client doesn't know (the API may have changed), so nothing is read from it.`);
}

/** True for a JSON object (not null, not a list). */
function isObject(value: unknown): value is Record<string, JsonValue | undefined> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The catalogue that lists the objects of a kind, by code. */
const CATALOGUE_OF = { table: "tables", cube: "cubes", timeseries: "timeseries" } as const;

/**
 * Why a data request found nothing: no object with that code, or the selection excluded every
 * value. GENESIS answers both with Status 104 (on this host its metadata does too, for a code that
 * doesn't exist); the catalogue lists the code when it exists, so it tells them apart (a saved
 * result is per account and in no public catalogue, so for one the reason names both).
 */
async function whyEmpty(client: RegionalstatistikClient, kind: DataKind, code: string, searched: Searched): Promise<string> {
  const filtered = Object.keys(searched).length > 0;
  if (kind === "result") {
    return "GENESIS found nothing: the saved result does not exist under this name (results are per account), or the selection excluded every value.";
  }
  let exists: boolean;
  try {
    const listed = await client.catalogue[CATALOGUE_OF[kind]]({ selection: code, searchcriterion: "Code", pagelength: 5 });
    exists = !isEmpty(listed) && Array.isArray(listed.List) && (listed.List as unknown as Record<string, unknown>[]).some((item) => item["Code"] === code);
  } catch (err) {
    if (noSuchObject(err)) exists = false;
    else throw err;
  }
  if (!exists) return `There is no ${kind} with the code ${code} (the catalogue doesn't list it). Search for the right code by topic; don't guess codes.`;
  return filtered
    ? `The ${kind} ${code} exists, but the selection excluded every value: check the region key (a Kreis has 5 digits like 08221, a Gemeinde 8; 08* for every Kreis of a Land) and the table's regional depth (…-4 Kreise, …-5 Gemeinden), then loosen the years or class keys; the ${kind}'s metadata names its variables.`
    : `The ${kind} ${code} exists but GENESIS sent no data for it.`;
}

// --- Decoding GENESIS's CSV ----------------------------------------------------------------

/**
 * The value symbols GENESIS writes instead of a number (Zeichenerklärung): kept as text, never
 * turned into 0.
 */
export const VALUE_SYMBOLS: Readonly<Record<string, string>> = {
  "-": "nothing (exactly zero or none)",
  ".": "unknown or kept secret",
  "...": "not available yet",
  "/": "no figure: not reliable enough",
  x: "no meaningful statement possible",
  "()": "limited reliability",
  e: "estimated",
  p: "provisional",
  r: "revised",
  s: "estimated",
};

/** The most significant digits any number with a fraction holds exactly (a double keeps 15). */
const EXACT_DIGITS = 15;

/**
 * A German-format number (`84.669.326`, `1.234,5`, `-0,8`), or undefined for anything else, and
 * for a figure with more digits than a number holds exactly (a whole number beyond 2^53 − 1, or
 * over 15 significant digits with a fraction): that stays text rather than come back with other
 * digits than GENESIS sent.
 */
export function germanNumber(text: string): number | undefined {
  const cell = text.trim();
  // Thousands dots in groups of three, an optional decimal comma; no leading zero (a region key
  // like 08221 or 01 stays text), no plain dot decimal (1.5 is not German and stays text). Without
  // dots at most four digits (a year, a count under 1000): GENESIS writes 1.000 and up with dots,
  // so 11000 or 14612000 is a region key (Berlin, Dresden) and stays text.
  if (!/^[-+]?(0|[1-9]\d{0,2}(\.\d{3})+|[1-9]\d{0,3})(,\d+)?$/.test(cell)) return undefined;
  const value = Number(cell.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  if (!cell.includes(",")) return Number.isSafeInteger(value) ? value : undefined;
  const digits = cell.replace(/[^0-9]/g, "").replace(/^0+/, "").replace(/0+$/, "");
  return digits.length <= EXACT_DIGITS ? value : undefined;
}

/** A cell as the answer gives it: the number for a German-format number, else the text as sent. */
export type Cell = string | number;

/** The fields of a ";"-delimited line ("" quoting as in CSV, which GENESIS uses in its flat files). */
export function splitCsvLine(line: string, delimiter = ";"): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/**
 * The lines of a CSV text (CRLF or LF; a trailing empty line dropped; a byte-order mark removed).
 * A line break inside a quoted cell (a quote at the start of a cell, as {@link splitCsvLine} reads
 * it) belongs to the cell, not a new line. One linear pass; a quote that never closes would make
 * the rest of the file one cell, so then the text is split at every line break instead.
 */
function csvLines(text: string, delimiter = ";"): string[] {
  const body = text.replace(/^\ufeff/, "");
  const lines: string[] = [];
  let start = 0;
  let quoted = false;
  let cellStart = true;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') i += 1;
        else quoted = false;
      }
    } else if (ch === '"' && cellStart) {
      quoted = true;
      cellStart = false;
    } else if (ch === "\n") {
      lines.push(body.slice(start, i > start && body[i - 1] === "\r" ? i - 1 : i));
      start = i + 1;
      cellStart = true;
    } else cellStart = ch === delimiter;
  }
  if (quoted) return trimEnd(body.split(/\r?\n/));
  lines.push(body.slice(start));
  return trimEnd(lines);
}

/** The lines without the empty ones at the end. */
function trimEnd(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  return lines;
}

// --- fetchData (regionalstatistik-data-fetch) ---------------------------------------------------------

/** The input of {@link fetchData}. */
export interface FetchDataInput extends DataSelection {
  kind?: DataKind | undefined;
  /** The object's exact code (12411-01-01-4). */
  code: string;
  /** The first line to give (default 0) and how many (default 200, at most 1000). */
  offset?: number | undefined;
  limit?: number | undefined;
}

/** The answer of {@link fetchData}. */
export type DataFetch =
  | {
      status: "ok";
      kind: DataKind;
      code: string;
      searched: Searched;
      /** The title GENESIS gives the object, when it gives one. */
      title?: string;
      /** All the lines of the table, headers and footnotes included. */
      total: number;
      offset: number;
      /** The lines from `offset`: each a list of cells, German numbers as numbers, everything else (symbols too) as sent. */
      lines: Cell[][];
      /** The value symbols that occur in the lines, with their meaning. */
      symbols: Record<string, string>;
      copyright: string;
      statusNote?: StatusNote;
    }
  | { status: "empty"; kind: DataKind; code: string; searched: Searched; reason: string; copyright: string };

const MAX_LINES = 1000;
const DEFAULT_LINES = 200;

/**
 * The data of one object, narrowed by the selection, with the CSV GENESIS sends inside
 * `Object.Content` decoded: one list of cells per line, German-format numbers (decimal comma,
 * thousands dots) as numbers, value symbols (`-`, `.`, `...`, `/`, `x`, …) kept as text and named.
 * Nothing found (Status 104) is `empty`, with the reason: no such code, or the selection excluded
 * everything (the code's metadata tells which). "Too large" (Status 98) is the client's error.
 */
export async function fetchData(client: RegionalstatistikClient, input: FetchDataInput): Promise<DataFetch> {
  const kind = input.kind ?? "table";
  const code = exactCode(input.code, kind);
  const offset = assertValid("offset", input.offset ?? 0, (v: number) => (Number.isSafeInteger(v) && v >= 0 ? undefined : "Expected a whole number from 0."));
  const limit = assertValid("limit", input.limit ?? DEFAULT_LINES, (v: number) => (Number.isSafeInteger(v) && v >= 1 && v <= MAX_LINES ? undefined : `Expected a whole number from 1 to ${MAX_LINES}.`));
  const { params, searched } = selectionParams(input);
  let answer;
  try {
    answer = await client.data[kind](code, params);
  } catch (err) {
    // GENESIS's "object not found" (Status 90), rarer than 104 for a wrong code.
    if (noSuchObject(err)) {
      return { status: "empty", kind, code, searched, reason: `GENESIS knows no ${kind} with the code ${code} (${err.message.replace(/ for POST \S+/, "")}). Search for the right code by topic; don't guess codes.`, copyright: "" };
    }
    throw err;
  }
  if (!isEmpty(answer) && !(isObject(answer.Object) && "Content" in answer.Object)) throw unexpectedShape(`data/${kind}`, "Object.Content");
  const content = answer.Object?.Content;
  if (isEmpty(answer) || typeof content !== "string" || content.trim() === "") {
    return { status: "empty", kind, code, searched, reason: await whyEmpty(client, kind, code, searched), copyright: answer.Copyright };
  }
  const all = csvLines(content).map((line) => splitCsvLine(line));
  const keyColumns = keyColumnsOf(all, input.regionKey);
  const lines = all.slice(offset, offset + limit).map((cells) => cells.map((cell, i): Cell => (keyColumns.has(i) ? cell : (germanNumber(cell) ?? cell))));
  const symbols: Record<string, string> = {};
  for (const line of lines) for (const cell of line) if (typeof cell === "string" && VALUE_SYMBOLS[cell.trim()] !== undefined) symbols[cell.trim()] = VALUE_SYMBOLS[cell.trim()] as string;
  const title = titleOf(answer.Object);
  const note = statusNote(answer);
  return {
    status: "ok",
    kind,
    code,
    searched,
    ...(title === undefined ? {} : { title }),
    total: all.length,
    offset,
    lines,
    symbols,
    copyright: answer.Copyright,
    ...(note === undefined ? {} : { statusNote: note }),
  };
}

/**
 * The columns that hold region keys, whose cells stay text. A column with a key that has a leading
 * zero (08221, 08) is one: so Berlin's 11000 is not a number where Heidelberg's 08221 is a key.
 * Keys without one (the Länder 10 to 16, their Regierungsbezirke 101 to 160) are found by the keys
 * asked for (`regionKey`): the leftmost column whose numbers are all plain digits matching one of
 * them is the key column, so a Länder table for "1*" doesn't give its keys as numbers.
 */
function keyColumnsOf(rows: readonly string[][], regionKey: string | undefined): Set<number> {
  const keyColumns = new Set<number>();
  for (const cells of rows) cells.forEach((cell, i) => /^0\d+$/.test(cell.trim()) && keyColumns.add(i));
  const asked = regionKeyTest(regionKey);
  if (asked === undefined) return keyColumns;
  const width = rows.reduce((most, cells) => Math.max(most, cells.length), 0);
  for (let i = 0; i < width; i += 1) {
    let matched = false;
    let other = false;
    for (const cells of rows) {
      const cell = (cells[i] ?? "").trim();
      if (/^\d{1,12}$/.test(cell) && asked(cell)) matched = true;
      else if (germanNumber(cell) !== undefined || /^\d+$/.test(cell)) other = true;
      if (other) break;
    }
    if (matched && !other) {
      keyColumns.add(i);
      break;
    }
  }
  return keyColumns;
}

/**
 * Whether a cell of digits is one of the region keys asked for: `regionKey` comma-separated, `*`
 * any characters. Checked without a regular expression, so a pattern full of stars stays linear.
 */
function regionKeyTest(regionKey: string | undefined): ((cell: string) => boolean) | undefined {
  if (regionKey === undefined) return undefined;
  const patterns = regionKey.split(",").map((item) => item.trim()).filter((item) => item !== "");
  if (patterns.length === 0) return undefined;
  return (cell) => patterns.some((pattern) => wildcardMatch(pattern, cell));
}

/** `*` matches any run of characters; everything else itself. Greedy with one backtrack point: linear in practice. */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = t;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** The object's title, when the data answer names one apart from its content. */
function titleOf(object: Record<string, JsonValue | undefined>): string | undefined {
  const title = object["Title"] ?? object["Content_Title"];
  return typeof title === "string" && title.trim() !== "" ? title : undefined;
}

// --- findStatistics (regionalstatistik-statistics-finder) -------------------------------------------

/** What `find` searches, by the names the answer uses. */
const FIND_LISTS = {
  Tables: "table",
  Statistics: "statistic",
  Cubes: "cube",
  Timeseries: "timeseries",
  Variables: "variable",
} as const;

/** One object a search or a catalogue found. */
export interface FoundObject {
  type: "table" | "statistic" | "cube" | "timeseries" | "variable" | "value";
  code: string;
  /** Its title, on one line (GENESIS breaks long titles). */
  title: string;
  /** The time span, where GENESIS gives one. */
  time?: string;
  /** The regional depth the title states ("Kreise und krfr. Städte", "Gemeinden"): match it to the question. */
  regionalDepth?: string;
  /** A statistic's number of cubes, a variable's number of values (-1 for a value variable without a list). */
  cubes?: number;
  values?: number;
  /** A variable's type (Merkmal, Wert, …). */
  variableType?: string;
}

/** The input of {@link findStatistics}. */
export interface FindStatisticsInput {
  /** A topic, in German for the best hits (Bevölkerung, Arbeitslose, Treibhausgase). */
  term: string;
  /** What to search: tables (default: the usable 2-D views), statistics, cubes, time-series, variables or all. */
  category?: FindCategory | undefined;
  /** At most this many per type (1–100, default 20). */
  limit?: number | undefined;
  language?: Language | undefined;
}

/** The answer of {@link findStatistics}. */
export type StatisticsSearch =
  | {
      status: "ok";
      searched: { term: string; category: FindCategory };
      matches: FoundObject[];
      perTypeLimit: number;
      /** False when a type's list reached `perTypeLimit`, or GENESIS changed a parameter (`statusNote`): more may exist (raise the limit, or narrow the term). */
      complete: boolean;
      copyright: string;
      statusNote?: StatusNote;
    }
  | { status: "empty"; searched: { term: string; category: FindCategory }; reason: string; copyright: string };

/**
 * The objects GENESIS's full-text search finds for a topic: their codes and titles, tables first.
 * `complete` is false when a type's list reached `limit` (GENESIS gives no total). No hit is
 * `empty` with what was searched (GENESIS answers it with success and every list null,
 * not with an error or an empty list).
 */
export async function findStatistics(client: RegionalstatistikClient, input: FindStatisticsInput): Promise<StatisticsSearch> {
  const term = normalizeText(assertValid("term", input.term, textProblem));
  const category = input.category ?? "tables";
  const limit = assertValid("limit", input.limit ?? 20, (v: number) => (Number.isSafeInteger(v) && v >= 1 && v <= 100 ? undefined : "Expected a whole number from 1 to 100."));
  const searched = { term, category };
  const answer = await client.find({ term, category, pagelength: limit, ...(input.language === undefined ? {} : { language: input.language }) });
  if (!isEmpty(answer) && !Object.keys(FIND_LISTS).some((list) => list in answer)) throw unexpectedShape("find/find", `any of its lists (${Object.keys(FIND_LISTS).join(", ")})`);
  const matches: FoundObject[] = [];
  let complete = true;
  for (const [list, type] of Object.entries(FIND_LISTS) as [keyof typeof FIND_LISTS, FoundObject["type"]][]) {
    const items = answer[list];
    if (!Array.isArray(items)) continue;
    if (items.length >= limit) complete = false;
    for (const item of items as unknown as Record<string, unknown>[]) matches.push(foundObject(type, item));
  }
  if (matches.length === 0 || isEmpty(answer)) {
    return {
      status: "empty",
      searched,
      reason:
        category === "all"
          ? "GENESIS's search found nothing for this term. Try a shorter or more general German word (Bevölkerung, not Einwohnerzahl), or browse the codes of a subject area."
          : `GENESIS's search found no ${category} for this term. Try the category all, a shorter or more general German word, or browse the codes of a subject area.`,
      copyright: answer.Copyright,
    };
  }
  const note = statusNote(answer);
  return {
    status: "ok",
    searched,
    matches,
    perTypeLimit: limit,
    complete: complete && note === undefined,
    copyright: answer.Copyright,
    ...(note === undefined ? {} : { statusNote: note }),
  };
}

/** A list item as a found object: the title on one line, counts as numbers. */
function foundObject(type: FoundObject["type"], item: Record<string, unknown>): FoundObject {
  const text = (key: string): string | undefined => (typeof item[key] === "string" && (item[key] as string).trim() !== "" ? (item[key] as string) : undefined);
  const count = (key: string): number | undefined => {
    const value = text(key);
    return value !== undefined && /^-?\d+$/.test(value.trim()) ? Number(value) : undefined;
  };
  const found: FoundObject = { type, code: text("Code") ?? "", title: (text("Content") ?? "").replace(/\s*\n\s*/g, " ") };
  const time = text("Time");
  if (time !== undefined) found.time = time;
  const depth = regionalDepthOf(found.title);
  if (depth !== undefined) found.regionalDepth = depth;
  if (type === "statistic" && count("Cubes") !== undefined) found.cubes = count("Cubes") as number;
  if ((type === "variable" || type === "value") && count("Values") !== undefined) found.values = count("Values") as number;
  if (type === "variable" && text("Type") !== undefined) found.variableType = text("Type") as string;
  return found;
}

/** The regional depth a Regionaldatenbank title states at its end ("… - regionale Tiefe: Kreise und krfr. Städte"). */
function regionalDepthOf(title: string): string | undefined {
  const depth = /regionale Tiefe:\s*(.+?)\s*$/i.exec(title)?.[1];
  return depth === undefined || depth === "" ? undefined : depth;
}

// --- browseCatalogue -----------------------------------------------------------------------

/** The input of {@link browseCatalogue}. */
export interface BrowseCatalogueInput {
  kind?: CatalogueKind | undefined;
  /** A code pattern with `*` (12411*, 124*), or a word of the title with `searchIn: "title"`. */
  selection: string;
  /** Match the selection against the code (default) or the title. */
  searchIn?: "code" | "title" | undefined;
  /** Sort by code (default) or title. */
  sortBy?: "code" | "title" | undefined;
  /** At most this many (1–500, default 50). */
  limit?: number | undefined;
  language?: Language | undefined;
}

/** The answer of {@link browseCatalogue}. */
export type CatalogueBrowse =
  | {
      status: "ok";
      searched: { kind: CatalogueKind; selection: string; searchIn: "code" | "title" };
      items: FoundObject[];
      /** False when the list reached `limit`, or GENESIS changed a parameter (`statusNote`, a shortened page). */
      complete: boolean;
      copyright: string;
      statusNote?: StatusNote;
    }
  | { status: "empty"; searched: { kind: CatalogueKind; selection: string; searchIn: "code" | "title" }; reason: string; copyright: string };

const CATALOGUE_TYPES: Record<CatalogueKind, FoundObject["type"]> = {
  tables: "table",
  statistics: "statistic",
  cubes: "cube",
  timeseries: "timeseries",
  variables: "variable",
  values: "value",
};

/**
 * The objects of one catalogue whose code (or title) matches a pattern, `*` as the wildcard:
 * `12411*` lists every table of statistic 12411. Nothing matched (Status 104) is `empty`.
 * `complete` is false when the list reached `limit` (GENESIS has no paging: ask for more) or GENESIS
 * changed a parameter (its status 22, kept as `statusNote`, may have shortened the page).
 */
export async function browseCatalogue(client: RegionalstatistikClient, input: BrowseCatalogueInput): Promise<CatalogueBrowse> {
  const kind = input.kind ?? "tables";
  const selection = normalizeToken(assertValid("selection", input.selection, tokenProblem));
  const searchIn = input.searchIn ?? "code";
  const limit = assertValid("limit", input.limit ?? 50, (v: number) => (Number.isSafeInteger(v) && v >= 1 && v <= 500 ? undefined : "Expected a whole number from 1 to 500."));
  const params: CatalogueParams = {
    selection,
    searchcriterion: searchIn === "title" ? "Content" : "Code",
    sortcriterion: input.sortBy === "title" ? "Content" : "Code",
    pagelength: limit,
    ...(input.language === undefined ? {} : { language: input.language }),
  };
  const searched = { kind, selection, searchIn };
  const answer = await client.catalogue[kind](params);
  if (!isEmpty(answer) && !("List" in answer)) throw unexpectedShape(`catalogue/${kind}`, "List");
  const list = Array.isArray(answer.List) ? (answer.List as unknown as Record<string, unknown>[]) : [];
  if (isEmpty(answer) || list.length === 0) {
    return {
      status: "empty",
      searched,
      reason:
        searchIn === "code" && !selection.includes("*")
          ? `No ${kind} has exactly the code ${selection}. Add * for every code that starts with it (${selection}*), or search by topic.`
          : `No ${kind} match ${selection}. Shorten the pattern (124* instead of 12411-*), or search by topic.`,
      copyright: answer.Copyright,
    };
  }
  const note = statusNote(answer);
  return {
    status: "ok",
    searched,
    items: list.map((item) => foundObject(CATALOGUE_TYPES[kind], item)),
    complete: list.length < limit && note === undefined,
    copyright: answer.Copyright,
    ...(note === undefined ? {} : { statusNote: note }),
  };
}

// --- describeObject (regionalstatistik-statistics-finder, step 3) -----------------------------------

/** One dimension (variable) of an object, from its metadata. */
export interface Dimension {
  code: string;
  title: string;
  /** Where it sits: a column or row of the table, or part of the head. */
  role?: string;
  /** Merkmal (a classifying variable), Wert (a value), Zeit, … */
  type?: string;
  /** How many values (keys) it has, where GENESIS says. */
  values?: number;
}

/** The input of {@link describeObject}. */
export interface DescribeObjectInput {
  kind?: MetadataKind | undefined;
  code: string;
  language?: Language | undefined;
}

/** The answer of {@link describeObject}. */
export type ObjectDescription =
  | {
      status: "ok";
      kind: MetadataKind;
      code: string;
      title?: string;
      /** The regional depth the title states (Kreise und krfr. Städte, Gemeinden). */
      regionalDepth?: string;
      /** From and to, where GENESIS gives the object's time span. */
      timeSpan?: { from?: string; to?: string };
      /** The variables found in the object's structure (its breakdowns and value columns). */
      dimensions: Dimension[];
      /** The metadata as GENESIS sent it. */
      metadata: JsonObject;
      copyright: string;
      statusNote?: StatusNote;
    }
  | { status: "empty"; kind: MetadataKind; code: string; reason: string; copyright: string };

/**
 * What an object is: its title, time span and dimensions (the variables a data request can filter
 * by, with their codes), from its metadata. A code that does not exist is `empty` (GENESIS answers
 * Status 104, not an error).
 */
export async function describeObject(client: RegionalstatistikClient, input: DescribeObjectInput): Promise<ObjectDescription> {
  const kind = input.kind ?? "table";
  const code = exactCode(input.code, kind);
  let answer;
  try {
    answer = await client.metadata[kind](code, input.language === undefined ? {} : { language: input.language });
  } catch (err) {
    if (noSuchObject(err)) {
      return { status: "empty", kind, code, reason: notFoundReason(kind, code), copyright: "" };
    }
    throw err;
  }
  const object = answer.Object;
  if (!isEmpty(answer) && !isObject(object)) throw unexpectedShape(`metadata/${kind}`, "Object");
  if (!isEmpty(answer) && kind === "table" && !("Structure" in (object as object))) throw unexpectedShape("metadata/table", "Object.Structure");
  if (isEmpty(answer) || object === undefined || object === null || typeof object !== "object") {
    return { status: "empty", kind, code, reason: notFoundReason(kind, code), copyright: answer.Copyright };
  }
  const title = typeof object["Content"] === "string" ? object["Content"].replace(/\s*\n\s*/g, " ") : undefined;
  const time = object["Time"];
  const timeSpan =
    time !== null && typeof time === "object" && !Array.isArray(time)
      ? {
          ...(typeof time["From"] === "string" && time["From"] !== "" ? { from: time["From"] } : {}),
          ...(typeof time["To"] === "string" && time["To"] !== "" ? { to: time["To"] } : {}),
        }
      : undefined;
  return {
    status: "ok",
    kind,
    code,
    ...(title === undefined ? {} : { title }),
    ...(title === undefined || regionalDepthOf(title) === undefined ? {} : { regionalDepth: regionalDepthOf(title) as string }),
    ...(timeSpan === undefined || Object.keys(timeSpan).length === 0 ? {} : { timeSpan }),
    dimensions: dimensionsOf(object["Structure"]),
    metadata: object,
    copyright: answer.Copyright,
    ...(statusNote(answer) === undefined ? {} : { statusNote: statusNote(answer) as StatusNote }),
  };
}

function notFoundReason(kind: string, code: string): string {
  return `There is no ${kind} with the code ${code}. Codes are exact (12411-01-01-4, not 12411): search by topic or browse the codes that start with it.`;
}

/** The variables in a metadata structure (Head, Columns, Rows, nested Structure), each once. */
function dimensionsOf(structure: JsonValue | undefined): Dimension[] {
  const found = new Map<string, Dimension>();
  const walk = (node: JsonValue | undefined, role: string | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, role);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const code = node["Code"];
    const type = node["Type"];
    if (typeof code === "string" && code !== "" && type !== "Statistik" && type !== "Statistic" && !found.has(code)) {
      const values = typeof node["Values"] === "string" && /^-?\d+$/.test(node["Values"]) ? Number(node["Values"]) : undefined;
      found.set(code, {
        code,
        title: typeof node["Content"] === "string" ? node["Content"].replace(/\s*\n\s*/g, " ") : "",
        ...(role === undefined ? {} : { role }),
        ...(typeof type === "string" && type !== "" ? { type } : {}),
        ...(values === undefined ? {} : { values }),
      });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "Head") walk(child, "head");
      else if (key === "Columns") walk(child, "column");
      else if (key === "Rows") walk(child, "row");
      else if (key === "Structure") walk(child, role);
    }
  };
  walk(structure, undefined);
  return [...found.values()];
}

// --- getFlatTable (regionalstatistik-table-download) ------------------------------------------------

/** The input of {@link getFlatTable}. */
export interface FlatTableInput extends DataSelection {
  kind?: DataKind | undefined;
  code: string;
  /** The first row to give (default 0) and how many (default 100, at most 1000). */
  offset?: number | undefined;
  limit?: number | undefined;
}

/** The answer of {@link getFlatTable}. */
export type FlatTable =
  | {
      status: "ok";
      kind: DataKind;
      code: string;
      searched: Searched;
      /** The file inside the download. */
      file: string;
      columns: string[];
      /** Data rows (the header line not counted). */
      total: number;
      offset: number;
      /** The rows from `offset`, each a list of cells as the file has them (text). */
      rows: string[][];
    }
  | { status: "empty"; kind: DataKind; code: string; searched: Searched; reason: string };

const FILE_METHODS = { table: "tableFile", cube: "cubeFile", timeseries: "timeseriesFile", result: "resultFile" } as const;

/**
 * The flat CSV ("ffcsv": one row per value, every dimension a column, English column names) of an
 * object, as GENESIS's download delivers it: the ZIP unpacked, the file decoded (UTF-8, else
 * Latin-1), split into columns and rows. The cells are text as in the file. Nothing found is
 * `empty` with the reason, as for {@link fetchData}.
 */
export async function getFlatTable(client: RegionalstatistikClient, input: FlatTableInput): Promise<FlatTable> {
  const kind = input.kind ?? "table";
  const code = exactCode(input.code, kind);
  const offset = assertValid("offset", input.offset ?? 0, (v: number) => (Number.isSafeInteger(v) && v >= 0 ? undefined : "Expected a whole number from 0."));
  const limit = assertValid("limit", input.limit ?? 100, (v: number) => (Number.isSafeInteger(v) && v >= 1 && v <= MAX_LINES ? undefined : `Expected a whole number from 1 to ${MAX_LINES}.`));
  const { params, searched } = selectionParams(input);
  let raw;
  try {
    raw = await client.data[FILE_METHODS[kind]](code, { ...(params as DataFileParams), format: "ffcsv" });
  } catch (err) {
    // A download that finds nothing is GENESIS's Status 104 instead of a file: the client throws it.
    if (noSuchObject(err)) {
      return { status: "empty", kind, code, searched, reason: await whyEmpty(client, kind, code, searched) };
    }
    throw err;
  }
  let file = `${code}.csv`;
  let bytes = raw.data;
  if (isZip(raw.data)) {
    // Only the file read is unpacked: the archive's other entries are never inflated.
    const entries = zipEntries(raw.data);
    const entry = entries.find((e) => /\.csv$/i.test(e.name)) ?? entries[0];
    if (entry === undefined) return { status: "empty", kind, code, searched, reason: "GENESIS sent an empty archive: no file in it." };
    file = entry.name;
    bytes = entry.read();
  }
  const text = decodeText(bytes);
  // The delimiter is the header's (the first line: column names hold no line break).
  const first = text.replace(/^\ufeff/, "").split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const lines = csvLines(text, delimiter);
  if (lines.length === 0) return { status: "empty", kind, code, searched, reason: `The file ${file} GENESIS sent is empty.` };
  const header = lines[0] as string;
  const columns = splitCsvLine(header, delimiter);
  const body = lines.slice(1);
  return {
    status: "ok",
    kind,
    code,
    searched,
    file,
    columns,
    total: body.length,
    offset,
    rows: body.slice(offset, offset + limit).map((line) => splitCsvLine(line, delimiter)),
  };
}

/** UTF-8 when the bytes are valid UTF-8, else Latin-1 (older GENESIS files). */
function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}
