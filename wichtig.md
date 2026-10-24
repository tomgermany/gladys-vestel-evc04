# Notizen zur Vestel EVC04

Die Regeln, die dieses Gerät von einem gewöhnlichen Modbus-Zähler unterscheiden.
Jede davon hat schon einmal Zeit gekostet, wenn sie übersehen wurde.

Was hier steht, ist aus dem Code, dem Handbuch oder einem Protokolllauf belegt. Wo
eine Angabe nicht belegt ist, steht das dabei — nicht als Unsicherheit, sondern damit
der nächste Leser weiß, ob er sich darauf verlassen kann.

## 1. Unit ID 255, nicht 1

Die EVC04 antwortet auf Unit ID **255**. Ein falscher Wert ist kein Fehler, den das
Gerät meldet: es antwortet einfach nicht. In `src/config.js` steht `unit_id: 255`.

## 2. Nur EIN Modbus-Master gleichzeitig

Der Hersteller sagt es ausdrücklich. Deshalb besitzt dieser Prozess genau eine
Verbindung, und der Verbindungstest benutzt sie mit, statt eine zweite aufzumachen
(`src/vestel/transport.js`).

In `index.js` steht ein Gate (`connecting`), das zwei gleichzeitige
Verbindungsaufbauten verhindert: `on('connected')` und `onConfigUpdated` rufen beide
`connectDevice()`, und bei einem Neustart feuern beide kurz nacheinander. Der zweite
Aufruf wartet auf den ersten, statt einen eigenen Socket zu öffnen.

`establish()` gibt eine **noch lebende** Verbindung zum selben Host und Port nicht auf,
sondern liest nur neu. Sonst reißt der Verbindungstest die laufende Verbindung ab und
baut eine zweite auf — bei einem Gerät mit einem Slot ist das der Fehler.

## 3. Der Alive-Register ist Pflicht, sobald gesteuert wird

Der Master schreibt **1** in Register **6000**; die Wallbox schreibt 0 zurück und
prüft den Register alle `failsafe_timeout / 2` Sekunden. Bleibt die Antwort aus,
schaltet sie auf den **Failsafe-Strom** (Register 2000) um.

- Das Zeitfenster ist **nie kleiner als 3 Sekunden**.
- Ohne den Herzschlag setzt eine Szene 16 A, die Wallbox lädt ein paar Sekunden mit
  16 A und fällt dann still auf den Failsafe-Wert zurück. Nichts errors, nichts wird
  geloggt, das Auto lädt nur langsamer als gewünscht.
- Umgesetzt in `src/alive.js`: `set()` startet den Schlag, `clear()` beendet ihn.
- **Der Schlag läuft nur, solange ein Sollwert gilt.** Das ist Absicht: Register 6000
  hält *unsere* Vorgabe in Kraft. Ohne Vorgabe gibt es nichts in Kraft zu halten, und
  die Wallbox arbeitet nach ihrer eigenen Konfiguration — also in dem Zustand, den der
  Nutzer vor der Integration hatte.

## 4. Geschrieben werden genau zwei Register

Alle anderen werden nur gelesen — auch die, die das Gerät als R/W deklariert:

- **Geschrieben:** `5004` (Ladestrom) und `6000` (Herzschlag). Beides ist
  Ladesteuerung, keine Konfiguration.
- **Nur gelesen:** die Grenzen `1102`, `1104`, `1106`, `1100` und der Failsafe-Block
  `2000`, `2002`.

## 5. Die Adressfrage — offen, und zwar belegbar offen

Die Herstellertabelle druckt Bereiche wie `Serial Number [100,124]`. Zwei Lesarten
sind möglich:

- **A) Byte-Bereiche** — 25 Bytes sind 13 Register, die Seriennummer beginnt bei 50.
  Das ist die Vorgabe: `ADDRESS_BASE = 'byte-ranges'` in `src/vestel/registers.js`.
- **B) Registeradressen** — die Zahlen sind schon Register, die Seriennummer beginnt
  bei 100.

**Diese Frage ist NICHT entschieden.** Ein Protokolllauf nach einem echten Start zeigt:

```
Wallbox ready: no serial, firmware unknown, 17 readings, charging current range 6-16 A
```

Die Zeichenketten kommen also **leer** zurück, während die 17 Messwerte sauber sind. Ein
leerer String ist kein Beweis für die falsche Lesart und keiner für die richtige: er kann
eine falsche Adresse sein, ein Gerät ohne gefüllten String-Block oder eine tolerierte
Ausnahme. `connect()` schluckt den Fehler bewusst (`catch(() => null)`), damit die
Messwerte nicht an der Identität scheitern.

Entschieden wird das am Gerät: `ADDRESS_BASE` auf `'registers'` umstellen und erneut
starten. Kommt dann lesbarer Text, war B richtig. Die einzelnen Registeradressen der
Mess- und Steuerblöcke sind unter beiden Lesarten dieselben — nur die String-Blöcke
hängen an dieser Frage.

## 6. Die Grenzen kommen vom Gerät, nicht aus dem Code

`src/vestel/client.js` liest vier Register:

- `1104` — EVSE Max Current, was der Installateur auf der Wallbox eingestellt hat,
- `1106` — Cable Max Current, was das angeschlossene Kabel verkraftet,
- `1100` — Session Max Current, das Maximum der laufenden Sitzung,
- `1102` — EVSE Min Current. **Wird gelesen, aber nicht als Untergrenze benutzt.**

Die Obergrenze ist das **Kleinste** der ersten drei. Die Untergrenze ist fest **6 A**,
unabhängig von `1102`: auf dem Referenzgerät antwortet `1102` mit 0.

**Am Gerät gemessen:** der Bereich ist `6-16 A`. Die Angabe „13 A", die früher hier
stand, ist NICHT belegt — sie stammt aus einer Annahme über dieses Gerät und wurde nie
als Messwert bestätigt.

Rückfallwert, falls das Gerät diese Register **gar nicht** beantwortet: 6 bis 16. Das
ist eine Notlösung, keine Angabe über das Gerät.

## 7. Drei Ströme, und zwei davon heißen gleich

Das ist die Verwechslung, die am meisten Zeit gekostet hat:

- `5004` — **Sollwert**, Ampere, schreibbar. Wird nie in den Snapshot gelesen.
- `1008` — **Messung L1**, Milliampere. 16000 heißt 16 A.
- `1500` — **Bericht der laufenden Sitzung**, Zehntelampere. 130 heißt 13 A.

`1500` ist der Wert, den ein Nutzer mit seinem Sollwert vergleicht. Er steht im
`POLL_PLAN` unter dem Schlüssel `charging_current` und trägt `scale: 1/10` in der
Feature-Zeile — die Umrechnung passiert **genau einmal**, dort.

## 8. Gerät und Kachel sind zwei Flächen

- **Das Gerät** (`src/devices/wallbox.js`) ist die Liste der Eigenschaften: Ladezustand
  als Satz und als Code, Kabelzustand, „Lädt" als Zahl, Leistung, die drei Ströme, die
  drei Spannungen, Zählerstand, Sitzungsenergie, die beiden Grenzen und der Ladestrom.
  Fünfzehn Zeilen, von denen der Ladestrom die einzige schreibbare ist.
- **Die Kachel** (`src/widgets.js`) zeigt bewusst weniger: den Zustand als einen Satz,
  den Ladestrom und zwei Knöpfe. Die Knöpfe bewegen den Sollwert um die Schrittweite,
  die in den Widget-Einstellungen gewählt wurde (`settings.step`, erlaubt 1, 2, 5).

Diese Trennung ist wichtig: eine Anweisung, die für die Kachel galt, wurde einmal auf das
Gerät angewandt, und sechzehn gelesene Werte wurden dadurch nie veröffentlicht.

## 9. Was beim Lesen zu beachten ist

- Ein Zustand ist `{ value, word }`. `Evc04Client.stateValue()` und `stateWord()` sind
  der **einzige** Weg dorthin; ein zweiter Test auf `typeof` an der Aufrufstelle ist,
  wie die beiden Formen verwechselt werden.
- **Eine 0 ist eine Messung, kein fehlender Wert.** Register 1500 antwortet 0, wenn
  keine Sitzung läuft. `Evc04Client.reading()` unterscheidet das; ein Test auf die Form
  vor dem Wert hatte eine echte 0 zu `null` gemacht.
- Ein Wert, den das Gerät nicht beantwortet, wird **weggelassen**, nicht als 0
  veröffentlicht.

## Was sonst noch gilt

- **Keine Skalierungsregister.** Die Einheiten stehen fest in der Tabelle: mA, V, W,
  0,1 kWh, Wh, A. Das ist der wesentliche Unterschied zu einem SunSpec-Gerät wie dem
  WattWächter.
- **Kategorien prüfen.** Eine Kategorie, die Gladys nicht kennt, lässt es das **ganze**
  Gerät verwerfen: `devices[0].features[n].category: unknown category`.
- **Die Szenenauslöser feuern auf der Flanke.** „Wallbox lädt" ist der Übergang 0 → 1
  des Registers 1001, nicht der Wert 1. Nach einem Neustart ist die vorige Flanke
  unbekannt und es feuert nichts.
- **`onScanRequest` gibt nichts zurück.** Die Entdeckung wird mit
  `publishDiscoveredDevices([...])` **veröffentlicht**. Ein Rückgabewert wird von
  niemandem gelesen — genau daran blieb die Entdeckungsseite leer.
- **`gladys.log` gibt es nicht.** Der Logger ist ein eigener Export des SDK: `logger`
  bzw. `createLogger({ name })`, mit `debug`/`info` auf stdout und `warn`/`error` auf
  stderr. Ein Aufruf auf `gladys` wirft, und im `catch` nimmt er die eigentliche
  Fehlermeldung mit.

## Getestet, und was getestet heißt

**Der Container läuft.** Belegt durch einen Protokolllauf:

```
[gladys-sdk] connected to Gladys
Wallbox ready: no serial, firmware unknown, 17 readings, charging current range 6-16 A, charging 0 (register 1500)
publishDiscoveredDevices -> "Wallbox" with 1 features
```

Das heißt: Verbindung zum Gladys-Kern steht, Konfiguration angekommen, die Wallbox
antwortet auf 17 Register, das Gerät wird zur Entdeckung angeboten.

**Und was es nicht heißt:** die Registeradressen der String-Blöcke (Punkt 5) sind nicht
bestätigt, und der Sollwert ist nie auf eine echte Last geschrieben worden. Ein Lauf mit
einem angeschlossenen Auto fehlt.
