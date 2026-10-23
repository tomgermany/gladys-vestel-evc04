# Notizen zur Vestel EVC04

Vier Regeln, die dieses Gerät von einem gewöhnlichen Modbus-Zähler unterscheiden.
Jede davon hat schon einmal Zeit gekostet, wenn sie übersehen wurde.

## 1. Unit ID 255, nicht 1

Die EVC04 antwortet auf Unit ID **255**. Ein falscher Wert ist kein Fehler, den das
Gerät meldet: es antwortet einfach nicht. In `src/config.js` steht `unit_id: 255`.

## 2. Nur EIN Modbus-Master gleichzeitig

Der Hersteller sagt es ausdrücklich. Deshalb besitzt dieser Prozess genau eine
Verbindung, und der Verbindungstest benutzt sie mit, statt eine zweite aufzumachen
(`src/vestel/transport.js`). Ein Verbindungsversuch, der trotzdem danebengeht, muss
das Socket mit `reset()` freigeben — ein liegen gebliebenes Socket nimmt dem nächsten
Start den Platz weg.

## 3. Der Alive-Register ist Pflicht, sobald gesteuert wird

Der Master schreibt **1** in Register **6000**; die Wallbox schreibt 0 zurück und
prüft den Register alle `failsafe_timeout / 2` Sekunden. Bleibt die Antwort aus,
schaltet sie auf den **Failsafe-Strom** (Register 2000) um.

- Das Zeitfenster ist **nie kleiner als 3 Sekunden**.
- Ohne den Herzschlag setzt eine Szene 16 A, die Wallbox lädt ein paar Sekunden mit
  16 A und fällt dann still auf den Failsafe-Wert zurück. Nichts errors, nichts wird
  geloggt, das Auto lädt nur langsamer als gewünscht.
- Umgesetzt in `src/alive.js`: `set()` startet den Schlag, `clear()` beendet ihn.

## 4. Die Adressfrage ist noch offen

Die Herstellertabelle druckt Bereiche wie `Serial Number [100,124]` und einzelne
Adressen wie `1008`. Zwei Lesarten sind möglich:

- **A) Byte-Bereiche** — 25 Bytes sind 13 Register, die Seriennummer beginnt bei 50.
  Das ist die Vorgabe in `src/vestel/registers.js`.
- **B) Registeradressen** — die Zahlen sind schon Register, die Seriennummer beginnt
  bei 100.

Entschieden wird das **am Gerät**, nicht am Schreibtisch:

1. Integration installieren, Adresse eintragen, **Verbindung prüfen** drücken.
2. Der Test gibt die Seriennummer aus. **Lesbarer Text** heißt Lesart A ist richtig.
   **`Modbus exception 2`** (illegal data address) oder Zeichensalat heißt: umstellen.
3. Umstellen ist eine Zeile: `ADDRESS_BASE` in `src/vestel/registers.js` auf
   `'registers'` setzen.

Die einzelnen Registeradressen der Mess- und Steuerblöcke sind unter beiden Lesarten
dieselben — nur die String-Blöcke hängen an dieser Frage.

## Was sonst noch gilt

- **Keine Skalierungsregister.** Die Einheiten stehen fest in der Tabelle: mA, V, W,
  0,1 kWh, Wh, A. Das ist der wesentliche Unterschied zu einem SunSpec-Gerät wie dem
  WattWächter.
- **Kategorien prüfen.** Eine Kategorie, die Gladys nicht kennt, lässt es das **ganze**
  Gerät verwerfen: `devices[0].features[n].category: unknown category`. Die
  Gerätesuche bleibt dann leer, während die Integration eine völlig gesunde Liste von
  Features loggt.
- **Ladestrom wird in Register 5004 gesetzt.** Der Wert wird gegen die Grenzen
  geklemmt, die das Gerät selbst meldet (EVSE-Minimum, EVSE-Maximum, Kabel-Maximum) —
  32 A anzunehmen und falsch zu liegen ist der Weg zur fliegenden Sicherung.
- **Registrierkarte der Kategorien** ist `energy-sensor`; der Ladestrom hängt als
  `current` daran.
- **Die Szenenauslöser feuern auf der Flanke.** „Wallbox lädt" ist der Übergang
  0 → 1 des Registers 1001, nicht der Wert 1. Ein Auslöser auf den Wert würde bei
  jedem Lesevorgang feuern, stundenlang.
