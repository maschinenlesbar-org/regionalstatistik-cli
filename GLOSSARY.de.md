# Glossar

Begriffe der Regionaldatenbank Deutschland und das Vokabular, das diese CLI
verwendet. Die Datenbank läuft auf der Software GENESIS: **Statistiken** bestehen aus
**Datenquadern**, die in **Tabellen** aufbereitet und durch **Merkmale** und deren
**Ausprägungen** beschrieben werden – und fast alles hat hier zusätzlich eine **regionale
Dimension**, die bis auf Kreis- und Gemeindeebene reicht.

## Objekte

| Begriff | GENESIS | Bedeutung |
|---|---|---|
| **Statistik** | `statistic` | Ein vollständiges statistisches Produkt, identifiziert über einen fünfstelligen EVAS-Code (z. B. `12411`, „Fortschreibung des Bevölkerungsstandes“). Enthält Datenquader. |
| **Tabelle** | `table` | Eine fertige zweidimensionale Ansicht mit einem Code wie `12411-01-01-4`. Das, was Sie hauptsächlich abrufen. |
| **Datenquader** | `cube` | Die mehrdimensionalen Rohdaten hinter den Tabellen. |
| **Zeitreihe** | `timeseries` | Ein Datenquader, reduziert auf einen einzelnen Wert im Zeitverlauf. |
| **Merkmal** | `variable` | Eine Dimension bzw. ein Attribut (z. B. `KREISE` = Kreise und kreisfreie Städte, `GES` = Geschlecht). |
| **Ausprägung** | `value` | Ein konkreter Wert eines Merkmals (z. B. ein bestimmter Kreis). |
| **Ergebnistabelle** | `result` | Eine von einem asynchronen Job erzeugte Tabelle, gespeichert in Ihrem Nutzerbereich. |

## Codes und Auswahl

- **EVAS-Code** – der numerische Schlüssel einer Statistik. `12` (Sachgebiet) → `12411`
  (Statistik).
- **Tabellencodes** haben die Form `12411-01-01-4`: EVAS-Statistik, Tabellennummer und eine
  abschließende Ziffer für die **regionale Tiefe** – z. B. `…-4` =
  Kreise und kreisfreie Städte, `…-5` = Gemeinden. Je tiefer die Tabelle, desto
  größer ist sie: Filtern Sie Tabellen auf Gemeindeebene mit `--region-key`, sonst erhalten
  Sie den Fehler „zu groß“ (98).
- **`selection`** – ein Code-Filter zum Durchsuchen mit `catalogue`; unterstützt den
  Platzhalter `*`, z. B. trifft `12411*` auf alle Objekte zu, deren Code mit `12411` beginnt.
- **`name`** – der exakte Objektcode, der an `metadata`/`data` übergeben wird.
- **`regionalvariable` / `regionalkey`** (CLI: `--region-var` / `--region-key`)
  – **der eigentliche Zweck dieser Datenbank.** Die regionale Ebene, nach der aufgeteilt
  wird, und die einzubeziehenden Regionen, ausgewählt über ihren amtlichen Schlüssel.
  Platzhalter `*` funktionieren: `--region-key "08*"` wählt jeden Kreis in
  Baden-Württemberg aus, `--region-key 08221` nur den Stadtkreis Heidelberg. Die gültigen
  Regionalmerkmale einer Tabelle ermitteln Sie mit `regstat metadata table <code>`.
- **`classifyingvariable{n}` / `classifyingkey{n}`** (CLI: `--class-var{n}` /
  `--class-key{n}`) – beschränken eine `data`-Anfrage auf bestimmte Ausprägungen
  nicht-regionaler Merkmale (z. B. Geschlecht).

## Regionalschlüssel und Ebenen

- **AGS** (Amtlicher Gemeindeschlüssel) – der amtliche achtstellige Gemeindeschlüssel
  `LL R KK GGG`: Land (2), Regierungsbezirk (1), Kreis (2), Gemeinde (3).
  Gekürzte Schlüssel bezeichnen die höheren Ebenen: `08` = Baden-Württemberg (Land),
  `08221` = Stadtkreis Heidelberg (Kreisebene).
- **ARS** (Amtlicher Regionalschlüssel) – die zwölfstellige Variante
  `LL R KK VVVV GGG`, die zusätzlich den **Gemeindeverband** (VVVV) enthält.
- **Regionale Tiefe** – die Ebene, auf der eine Tabelle veröffentlicht wird: Deutschland →
  Land → Regierungsbezirk / Statistische Region → Kreise und kreisfreie Städte →
  Gemeindeverbände → Gemeinden. Typische Regionalmerkmale: `DINSG`
  (Deutschland), `DLAND` (Bundesländer), `REGBEZ` (Regierungsbezirke), `KREISE`
  (Kreise und kreisfreie Städte), `GEMEIN` (Gemeinden) – prüfen Sie sie je Tabelle mit
  `metadata`, sie unterscheiden sich.
- **Kreis / kreisfreie Stadt** – die NUTS-3-Ebene; **Gemeinde** – LAU-Ebene;
  **Gemeindeverband** – Zusammenschluss von Gemeinden.
- **NUTS** – die regionale Gebietssystematik der EU. Grob: NUTS-1 = Länder, NUTS-2 =
  Regierungsbezirke/Statistische Regionen, NUTS-3 = Kreise; Gemeinden gehören zur LAU-Ebene.
  Die Datenbank verwendet AGS/ARS als Schlüssel, nicht NUTS.

## Die Antworthülle

Jede Antwort außer von `helloworld` steckt in einer Hülle:

| Feld | Bedeutung |
|---|---|
| `Ident` | `{ Service, Method }` – welcher Endpoint geantwortet hat. |
| `Status` | `{ Code, Content, Type }` – das **logische** Ergebnis (siehe unten). |
| `Parameter` | Echo Ihrer Anfrage (Zugangsdaten maskiert als `********`). |
| `Copyright` | der anzugebende Quellenvermerk – siehe [DATA_LICENSE.md](DATA_LICENSE.md). |
| `List` | Katalogergebnisse (ein homogenes Array). |
| `Object` | Nutzdaten für Daten und Metadaten (nicht näher typisiert; bei `data/table` ein CSV-String in `Object.Content`). |

`helloworld/whoami` und `helloworld/logincheck` verwenden diese Hülle **nicht** –
ebenso wenig **Authentifizierungsfehler**, die als bloßes
`{ Code, Content, Type }`-Objekt ankommen (siehe unten).

## Werte von `Status.Code`

Die meisten logischen Ergebnisse kommen mit HTTP `200`; Authentifizierungsfehler liefern
dieselbe Struktur mit 401/404:

| Code | Typ | Bedeutung | Diese CLI |
|---|---|---|---|
| `0` | Information | Erfolg | liefert Daten |
| `22` | Warnung | Erfolg, ein Parameter wurde automatisch korrigiert | liefert Daten (Warnung in `Status.Content` sichtbar) |
| `50` | Information | keine neueren Daten (bei `--stand`) | liefert Daten |
| `104` | Information | kein Objekt gefunden, das passt | liefert ein **leeres** Ergebnis (Exit 0) |
| `90` | Fehler | angefordertes Objekt nicht gefunden | Fehler, **Exit 4** |
| `98` | Information | Ergebnis zu groß für einen direkten Abruf | Fehler mit Hinweisen zum Eingrenzen, Exit 1 |
| `15` | ERROR | nicht autorisiert (keine oder nicht erkannte Zugangsdaten; flacher Body bei HTTP 401) | Fehler + Hinweis zu den Zugangsdaten, Exit 1 |
| `2` | ERROR | falscher Benutzername oder falsches Passwort (flacher Body bei HTTP **404** – kein fehlendes Objekt!) | Fehler, Exit 1 |
| beliebig | Fehler / Error | allgemeiner Fehler | Fehler, Exit 1 |

## Platzhalter für den Wertstatus

In einer CSV aus `data/table` kann eine Zelle statt einer Zahl ein Statuszeichen enthalten:
`-` (nichts vorhanden / tatsächlich null), `.` (unbekannt oder geheim – auf
Gemeindeebene wegen der statistischen Geheimhaltung häufig), `...` (noch nicht verfügbar),
`/` (keine Angabe, da Zahlenwert nicht sicher genug), `x` (keine sinnvolle Aussage
möglich), `()` (eingeschränkter Aussagewert), `p` (vorläufig), `r` (berichtigt),
`s` (geschätzt).

## Begriffe zur Authentifizierung

- **Benutzername / Passwort** – die Anmeldedaten der kostenlosen Registrierung unter
  https://www.regionalstatistik.de/genesis/online (seit Mai 2025 für die API-Nutzung
  Pflicht). Nur gemeinsam anzugeben.
- **API-Token** – ein persönliches Token, das Sie in der GENESIS-Weboberfläche
  (Bereich „Webservice/API“) erzeugen, sofern dort angeboten. Es wird ohne Passwort im
  Anfragefeld `username` übertragen und hat Vorrang vor Benutzername/Passwort, wenn beides
  gesetzt ist.

Wie Zugangsdaten übertragen werden und warum Weiterleitungen nicht gefolgt wird, beschreibt
[DEVELOPING.md](DEVELOPING.md) (englisch).
