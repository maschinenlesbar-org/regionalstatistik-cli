// Canned GENESIS response bodies used across the unit tests. Shapes mirror the
// live regionalstatistik.de API's common envelope (Ident/Status/Parameter/
// Copyright + List|Object), trimmed to the fields the tests assert on.

const COPYRIGHT =
  "© Statistische Ämter des Bundes und der Länder, 2026; Datenlizenz Deutschland – Namensnennung – Version 2.0";

/** Wrap a payload in the standard GENESIS envelope with a chosen Status. */
export function envelope(
  payload: Record<string, unknown>,
  status: { Code?: number; Content?: string; Type?: string } = {},
): Record<string, unknown> {
  return {
    Ident: { Service: "test", Method: "test" },
    Status: {
      Code: status.Code ?? 0,
      Content: status.Content ?? "erfolgreich",
      Type: status.Type ?? "Information",
    },
    Parameter: { username: "********" },
    Copyright: COPYRIGHT,
    ...payload,
  };
}

export const tablesList = envelope({
  List: [
    {
      Code: "12411-01-01-4",
      Content:
        "Bevölkerungsstand: Bevölkerung nach Geschlecht - Stichtag 31.12. - regionale Tiefe: Kreise und krfr. Städte",
      Time: "1995 - 2023",
    },
  ],
});

export const findResult = envelope({
  Tables: [{ Code: "12411-01-01-4", Content: "Bevölkerungsstand: Bevölkerung nach Geschlecht (Kreise)" }],
  Statistics: [{ Code: "12411", Content: "Fortschreibung des Bevölkerungsstandes", Cubes: "3" }],
  Cubes: null,
  Timeseries: null,
  Variables: null,
});

export const dataTable = envelope({
  Object: {
    Content:
      "Statistik;12411;;;\nStichtag;Kreise und kreisfreie Städte;Insgesamt\n31.12.2023;08221 Heidelberg, Stadtkreis;162.273\n",
  },
});

export const metadataTable = envelope({
  Object: {
    Code: "12411-01-01-4",
    Content: "Bevölkerungsstand: Bevölkerung nach Geschlecht (Kreise und krfr. Städte)",
  },
});

// --- Status variants ------------------------------------------------------------

export const notFound = envelope({}, { Code: 90, Type: "Fehler", Content: "Der angeforderte Wert wurde nicht gefunden." });
export const tooLarge = envelope({}, { Code: 98, Type: "Information", Content: "Die Tabelle ist zu groß für einen direkten Abruf." });
export const emptyResult = envelope({ List: [] }, { Code: 104, Type: "Information", Content: "Es wurden keine Ergebnisse gefunden." });
export const genericError = envelope({}, { Code: -1, Type: "Fehler", Content: "Ein unerwarteter Fehler ist aufgetreten." });
export const warning = envelope(
  { List: [{ Code: "12411-01-01-4", Content: "Bevölkerungsstand (Kreise)" }] },
  { Code: 22, Type: "Warnung", Content: "Der Parameter wurde automatisch korrigiert." },
);

// --- Flat (envelope-less) auth errors -------------------------------------------
// Verified live on www.regionalstatistik.de (2026-07-13): authentication
// failures come back HTTP 200 with a bare `{ Code, Content, Type }` object at
// the top level — no Ident/Status/Parameter/Copyright around it.

/** No credentials sent at all. */
export const flatNotAuthorized = {
  Code: 15,
  Content:
    "Sie sind nicht berechtigt diesen Service aufzurufen oder der Header Ihres Requests enthält nicht alle notwendigen Angaben, sodass Ihre Zugangsdaten nicht erkannt werden.",
  Type: "ERROR",
};

/** Wrong username/password. */
export const flatBadCredentials = {
  Code: 2,
  Content: "Ein Fehler ist aufgetreten. (Bitte prüfen und korrigieren Sie Ihren Nutzernamen bzw.\n das Passwort.)",
  Type: "ERROR",
};

// --- helloworld (no envelope) ---------------------------------------------------
// The live regionalstatistik.de whoami returns only User-Agent (no User-IP).

export const whoami = { "User-Agent": "regionalstatistik-cli" };
export const loginOk = {
  Status:
    "Sie wurden erfolgreich an- und abgemeldet! Bei mehr als 10 parallelen Requests wurden länger als 15 Minuten laufende Requests beendet.",
  Username: "TESTUSER12",
};
