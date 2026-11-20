// Answers of the Regionaldatenbank Deutschland (GENESIS) for the operation and MCP tests.
//
// Recorded live (2026-11-20, without an account): NOT_AUTHORIZED, what `find` answers a request
// without a login (HTTP 401, the flat `{ Code: 15 }` body). This host serves no guest searches:
// find, catalogue, metadata and data all need an account, which these tests don't have.
//
// Built from GENESIS's documentation (the 2020 web service's find/data/metadata/catalogue answers)
// and the answers recorded on the sibling GENESIS-Online host (destatis-genesis-cli's
// test/recorded.ts: the same GENESIS software, the same envelope and lists), with this database's
// codes, regional keys and copyright: the envelope (Ident/Status/Parameter/Copyright), the find
// lists (null when not searched or nothing matched, counts as strings, line breaks in long
// titles), `Object.Content` the ";"-delimited CSV with German numbers and region keys,
// `Object.Structure` the Head, Columns and Rows of variables, and the flat CSV "ffcsv" one row per
// value. A live check with an account is still open.

import { deflateRawSync } from "node:zlib";

export const COPYRIGHT = "© Statistische Ämter des Bundes und der Länder, 2026; Datenlizenz Deutschland – Namensnennung – Version 2.0";

/** The envelope of a GENESIS answer around `payload`. */
export function genesis(service: string, method: string, payload: Record<string, unknown>, status: { Code?: number; Content?: string; Type?: string } = {}): Record<string, unknown> {
  return {
    Ident: { Service: service, Method: method },
    Status: { Code: status.Code ?? 0, Content: status.Content ?? "erfolgreich", Type: status.Type ?? "Information" },
    Parameter: { username: "********************", password: "********************" },
    ...payload,
    Copyright: COPYRIGHT,
  };
}

/** Recorded live (2026-11-20): `find` without a login, HTTP 401. */
export const NOT_AUTHORIZED = {
  Code: 15,
  Content:
    "Sie sind nicht berechtigt diesen Service aufzurufen oder der Header Ihres Requests enthält nicht alle notwendigen Angaben, sodass Ihre Zugangsdaten nicht erkannt werden.",
  Type: "ERROR",
};

/** Wrong username, password or token: the flat code 2, which this host sends with HTTP 404. */
export const BAD_LOGIN = {
  Code: 2,
  Content: "Ein Fehler ist aufgetreten. (Bitte prüfen und korrigieren Sie Ihren Nutzernamen bzw.\n das Passwort.)",
  Type: "ERROR",
};

const KREISE_4 = "Bevölkerungsstand: Bevölkerung nach Geschlecht - Stichtag 31.12. -\nregionale Tiefe: Kreise und krfr. Städte";
const GEMEINDEN_5 = "Bevölkerungsstand: Bevölkerung nach Geschlecht - Stichtag 31.12. -\nregionale Tiefe: Gemeinden";
const ALTER_4 = "Bevölkerungsstand: Bevölkerung nach Geschlecht und\nAltersgruppen (17) - Stichtag 31.12. - regionale Tiefe: Kreise\nund krfr. Städte";

/** `find "Bevölkerung" --category tables --pagelength 3`. */
export const FIND_TABLES = genesis("find", "find", {
  Cubes: null,
  Statistics: null,
  Tables: [
    { Code: "12411-01-01-4", Content: KREISE_4, Time: "", Valid: "true" },
    { Code: "12411-01-01-5", Content: GEMEINDEN_5, Time: "", Valid: "true" },
    { Code: "12411-02-03-4", Content: ALTER_4, Time: "", Valid: "true" },
  ],
  Timeseries: null,
  Variables: null,
});

/** `find "Bevölkerungsstand" --category all --pagelength 2`. */
export const FIND_ALL = genesis("find", "find", {
  Cubes: null,
  Statistics: [{ Code: "12411", Content: "Fortschreibung des Bevölkerungsstandes", Cubes: "6", Information: "true" }],
  Tables: [
    { Code: "12411-01-01-4", Content: KREISE_4, Time: "", Valid: "true" },
    { Code: "12411-01-01-5", Content: GEMEINDEN_5, Time: "", Valid: "true" },
  ],
  Timeseries: null,
  Variables: [
    { Code: "BEVSTD", Content: "Bevölkerungsstand", Type: "Wert", Values: "-1", Information: "true" },
    { Code: "KREISE", Content: "Kreise und kreisfreie Städte", Type: "Merkmal", Values: "400", Information: "true" },
  ],
});

/** `find "Xyzzyquux"`: success, and every list null. */
export const FIND_NONE = genesis("find", "find", { Cubes: null, Statistics: null, Tables: null, Timeseries: null, Variables: null });

/** Nothing matched (Status 104), as data and metadata answer it: no Object. */
export const EMPTY_104 = (service: string, method: string): Record<string, unknown> =>
  genesis(service, method, {}, { Code: 104, Content: "Es gibt keine Objekte zum angegebenen Selektionskriterium", Type: "Information" });

/** `catalogue tables "12411*"`. */
export const TABLES_12411 = genesis("catalogue", "tables", {
  List: [
    { Code: "12411-01-01-4", Content: KREISE_4, Time: "1995-2023" },
    { Code: "12411-01-01-5", Content: GEMEINDEN_5, Time: "1995-2023" },
    { Code: "12411-02-03-4", Content: ALTER_4, Time: "2011-2023" },
  ],
});

/** `data table 12411-01-01-4 --region-key "08221,08222,11000" --start-year 2023`. */
export const DATA_12411_01_01_4 = genesis("data", "table", {
  Object: {
    Code: "12411-01-01-4",
    Content:
      "GENESIS-Tabelle: 12411-01-01-4\nBevölkerungsstand: Bevölkerung nach Geschlecht - Stichtag 31.12. - regionale Tiefe: Kreise und krfr. Städte;;;;;\n" +
      "Fortschreibung des Bevölkerungsstandes;;;;;\nBevölkerungsstand (Anzahl);;;;;\n;;;Insgesamt;männlich;weiblich\n" +
      "31.12.2023;08221;Heidelberg, Stadtkreis;162.273;78.935;83.338\n" +
      "31.12.2023;08222;Mannheim, Universitätsstadt, Stadtkreis;315.554;157.203;158.351\n" +
      "31.12.2023;11000;Berlin, Stadt;3.878.100;1.906.524;1.971.576\n" +
      "__________;;;;;\n© Statistische Ämter des Bundes und der Länder, 2026;;;;;\n",
    Structure: null,
  },
});

/** A Gemeinde table with value symbols (`.` kept secret, `-` nothing, `...` not yet available). */
export const DATA_SYMBOLS = genesis("data", "table", {
  Object: {
    Code: "82111-01-03-5",
    Content: "Gemeinde;Schlüssel;2021;2022\nHeidelberg;08221000;1.234,5;...\nBammental;08226006;-;.\nDossenheim;08226013;/;x\n",
  },
});

/** `metadata table 12411-01-01-4`. */
export const METADATA_12411_01_01_4 = genesis("metadata", "table", {
  Object: {
    Code: "12411-01-01-4",
    Content: KREISE_4,
    Time: { From: "1995", To: "2023" },
    Valid: "false",
    Structure: {
      Head: {
        Code: "12411",
        Content: "Fortschreibung des Bevölkerungsstandes",
        Type: "Statistik",
        Values: null,
        Selected: null,
        Structure: [{ Code: "KREISE", Content: "Kreise und kreisfreie Städte", Type: "Merkmal", Values: "400", Selected: null, Structure: null, Updated: "see parent" }],
        Updated: "18.06.2024 10:00:00h",
      },
      Columns: [
        { Code: "GES", Content: "Geschlecht", Type: "Merkmal", Values: "2", Selected: null, Structure: [{ Code: "BEVSTD", Content: "Bevölkerungsstand", Type: "Wert", Values: "-1", Selected: null, Structure: null, Updated: "see parent" }], Updated: "18.06.2024 10:00:00h" },
      ],
      Rows: [{ Code: "STAG", Content: "Stichtag", Type: "Merkmal", Values: "29", Selected: null, Structure: null, Updated: "18.06.2024 10:00:00h" }],
      Subtitel: null,
    },
    Updated: "18.06.2024 10:00:00h",
  },
});

/** The flat CSV ("ffcsv") of 12411-01-01-4 for Heidelberg in 2022 and 2023, as the download's ZIP holds it. */
export const FFCSV_12411_01_01_4 =
  "statistics_code;statistics_label;time_code;time_label;time;1_variable_code;1_variable_label;1_variable_attribute_code;1_variable_attribute_label;value;value_unit;value_variable_code;value_variable_label\n" +
  "12411;Fortschreibung des Bevölkerungsstandes;STAG;Stichtag;2022-12-31;KREISE;Kreise und kreisfreie Städte;08221;Heidelberg, Stadtkreis;161485;Anzahl;BEVSTD;Bevölkerungsstand\n" +
  "12411;Fortschreibung des Bevölkerungsstandes;STAG;Stichtag;2023-12-31;KREISE;Kreise und kreisfreie Städte;08221;Heidelberg, Stadtkreis;162273;Anzahl;BEVSTD;Bevölkerungsstand\n";

/** A ZIP archive of `files` (deflated unless `stored`), as GENESIS wraps its downloads. */
export function zipOf(files: Record<string, string | Buffer>, options: { stored?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = options.stored === true ? data : deflateRawSync(data);
    const method = options.stored === true ? 0 : 8;
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
