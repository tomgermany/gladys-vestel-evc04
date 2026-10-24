# Notizen zur Vestel EVC04

Die Regeln, die dieses Gerät von einem gewöhnlichen Modbus-Zähler unterscheiden.
Jede davon hat schon einmal Zeit gekostet, wenn sie übersehen wurde.

## 1. Unit ID 255, nicht 1

Die EVC04 antwortet auf Unit ID **255**. Ein falscher Wert ist kein Fehler, den das
Gerät meldet: es antwortet einfach nicht. In `src/config.js` steht `unit_id: 255`.

## 2. Nur EIN Modbus-Master gleichzeitig

Der Hersteller sagt es ausdrücklich. Deshalb besitzt dieser Prozess genau eine
Verbindung, und der Verbindungstest benutzt sie mit, statt eine zweite aufzumachen
(`src/vestel/transport.js`).

Die Verbindung wird **einmal gebaut und nie ersetzt**: `index.js` legt einen
`Evc04Client` an, und auch die Konfigurationsänderung tauscht ihn nicht aus, sondern
schreibt nur Adresse und Unit ID in den bestehenden Client um. Vorher wird das alte
Socket mit `close()` **geschlossen und abgewartet** — nicht mit `reset()`, das sofort
zurückkommt und die FIN erst später beim Gerät ankommen lässt. Bei einem Gerät mit
einem einzigen Master-Slot ist ein liegen gebliebenes Socket genau das, was den
nächsten Start blockiert.

## 3. Der Alive-Register ist Pflicht, sobald gesteuert wird

Der Master schreibt **1** in Register **6000**; die Wallbox schreibt 0 zurück und
prüft den Register alle `failsafe_timeout / 2` Sekunden. Bleibt die Antwort aus,
schaltet sie auf den **Failsafe-Strom** (Register 2000) um.

- Das Zeitfenster ist **nie kleiner als 3 Sekunden**.
- Ohne den Herzschlag setzt eine Szene 16 A, die Wallbox lädt ein paar Sekunden mit
  16 A und fällt dann still auf den Failsafe-Wert zurück. Nichts errors, nichts wird
  geloggt, das Auto lädt nur langsamer als gewünscht.
- Umgesetzt in `src/alive.js`: `set()` startet den Schlag, `clear()` beendet ihn.
- **Der Schlag läuft nur, solange ein Sollwert gilt.** Das ist Absicht und nicht die
  Sparversion: Register 6000 hält *unsere* Vorgabe in Kraft. Ohne Vorgabe gibt es
  nichts in Kraft zu halten, und die Wallbox arbeitet nach ihrer eigenen
  Konfiguration — also in dem Zustand, den der Nutzer vor der Integration hatte.
  Dauerhaft zu schreiben würde das Gerät für nichts überschreiben.
Wenn du willst, dass er trotzdem durchläuft: `control.set()` beim Start statt beim
Setzen des Stroms aufrufen. Es ist eine Zeile, aber nötig ist es nicht.

## 4. Geschrieben werden genau zwei Register

Alle anderen werden nur gelesen — auch die, die das Gerät als R/W deklariert:

- **Geschrieben:** `5004` (Ladestrom) und `6000` (Herzschlag). Beides ist
  Ladesteuerung, keine Konfiguration.
- **Nur gelesen:** die Grenzen `1102`, `1104`, `1106` und der Failsafe-Block
  `2000`, `2002`. Was du in der Wallbox einträgst, gilt — wer nicht ans Gerät geht,
  kommt an diese Werte nicht heran.

## 5. Die Adressfrage ist entschieden

Die Herstellertabelle druckt Bereiche wie `Serial Number [100,124]` und einzelne
Adressen wie `1008`. Zwei Lesarten waren möglich:

- **A) Byte-Bereiche** — 25 Bytes sind 13 Register, die Seriennummer beginnt bei 50.
- **B) Registeradressen** — die Zahlen sind schon Register, die Seriennummer beginnt
  bei 100.

**Am Gerät entschieden: Lesart A gilt.** Die Seriennummer kam beim ersten
Verbindungstest als lesbarer Text zurück, und das ist das Merkmal, an dem sich das
entscheidet. `ADDRESS_BASE` in `src/vestel/registers.js` steht auf `'byte-ranges'`.

Sollte ein anderes Gerät derselben Baureihe einmal Zeichensalat oder
`Modbus exception 2` liefern, ist die Umstellung eine Zeile: `ADDRESS_BASE` auf
`'registers'`. Die einzelnen Registeradressen der Mess- und Steuerblöcke sind unter
beiden Lesarten dieselben — nur die String-Blöcke hängen an dieser Frage.

## 6. Die Grenzen kommen vom Gerät, nicht aus dem Code

Naheliegend wäre, den Ladestrom-Bereich fest einzubauen: 6 bis 16 A. **So ist es
nicht, und das ist der Punkt.**

`src/vestel/client.js` liest vier Register und nimmt das **Kleinste** der drei
oberen als Obergrenze:

- `1104` — EVSE Max Current, was der Installateur auf der Wallbox eingestellt hat,
- `1106` — Cable Max Current, was das angeschlossene Kabel verkraftet,
- `1100` — Session Max Current, das Maximum der laufenden Sitzung; ein Fahrzeug darf
  weniger verlangen als Gerät oder Kabel erlauben.

Die Untergrenze ist **6 A**, unabhängig von `1102`: auf dem Referenzgerät antwortet
`1102` mit 0, und das ist ein Sollwert, den die Wallbox verweigert.

Auf dem Referenzgerät ist das Maximum **13 A**, nicht 16. Ein Sollwert darüber ist
kein Fehler, den die Wallbox meldet — sie lädt einfach mit ihrem eigenen Maximum,
während Gladys die Zahl anzeigt, nach der gefragt wurde. Deshalb wird jeder Sollwert
geklemmt, und deshalb liefert `buildDevice()` die gelesenen Grenzen mit.

Rückfallwert, falls das Gerät diese Register **gar nicht** beantwortet: 6 bis 16.
Das ist eine Notlösung, keine Angabe über das Gerät.

## Was sonst noch gilt

- **Keine Skalierungsregister.** Die Einheiten stehen fest in der Tabelle: mA, V, W,
  0,1 kWh, Wh, A. Das ist der wesentliche Unterschied zu einem SunSpec-Gerät wie dem
  WattWächter.
- **Kategorien prüfen.** Eine Kategorie, die Gladys nicht kennt, lässt es das **ganze**
  Gerät verwerfen: `devices[0].features[n].category: unknown category`. Die
  Gerätesuche bleibt dann leer, während die Integration eine völlig gesunde Liste von
  Features loggt.
- **Registrierkarte der Kategorien** ist `energy-sensor`; der Ladestrom hängt als
  `current` daran.
- **Die Szenenauslöser feuern auf der Flanke.** „Wallbox lädt" ist der Übergang
  0 → 1 des Registers 1001, nicht der Wert 1. Ein Auslöser auf den Wert würde bei
  jedem Lesevorgang feuern, stundenlang. Nach einem Neustart ist die vorige Flanke
  unbekannt und es feuert nichts — sonst würde „Ladevorgang begonnen" für eine
  Sitzung gemeldet, die vor dem Neustart angefangen hat.
- **Noch nicht am Gerät getestet.** Der Code ist gegen die Spezifikation gebaut und
  durch Lint und Tests gelaufen, aber noch nie mit einer echten Wallbox verbunden.
  **Das gilt weiterhin, auch nach dem grünen Lauf.** Grün heißt: Lint und Tests
  laufen durch. Es heißt nicht: die Register sind an dieser Wallbox bestätigt.
