- Herstellerdokument: Vestel EVC04 Modbus TCP/IP Specification, Revision v1.5.
  Die Registertabelle daraus ist in `src/vestel/registers.js` abgebildet.
- Modbus TCP, Port 502, Unit ID 255. Es ist zu jedem Zeitpunkt nur EIN Master erlaubt.
- Der Alive-Register (6000) muss vom Master zyklisch mit 1 beschrieben werden, sonst
  wechselt die Wallbox auf den Failsafe-Strom. Zeitfenster: Failsafe-Timeout / 2,
  jedoch nie unter 3 Sekunden.
- Ladestrom wird in Register 5004 gesetzt.

## Was geschrieben wird und was nicht

Genau zwei Register werden geschrieben, und beide sind Ladesteuerung statt
Konfiguration:

- `5004` - der Ladestrom, begrenzt auf das, was die Wallbox erlaubt
- `6000` - der Herzschlag, ohne den der Ladestrom nicht hält

Alles andere wird nur gelesen. Ausdrücklich auch:

- die Grenzen `1102`, `1104`, `1106` - der Wert, den du in der Wallbox einträgst,
  gilt. Ein Sollwert oberhalb wird geklemmt, nicht durchgesetzt.
- der Failsafe-Block `2000` und `2002` - auf dem Gerät als R/W deklariert, hier nur
  lesbar. Wer nicht an die Wallbox selbst geht, kommt an diese Werte nicht heran.

Damit kann ein Szenenschreiber, der das Gerät nicht kennt, den Ladestrom beeinflussen
und nichts an der Konfiguration verstellen.

## Geprüft und noch offen

- **Adressfrage.** Die Adressangaben der Herstellertabelle sind vermutlich
  BYTE-Bereiche. Ob das so ist, entscheidet das Gerät: der Verbindungstest gibt die
  Seriennummer aus. Lesbarer Text heißt richtig, `Modbus exception 2` heißt falsch.
  Umzustellen ist eine Zeile: `ADDRESS_BASE` in `src/vestel/registers.js`.
- **Ladestrom-Bereich.** Am Gerät einstellbar sind 6 bis 16 A in Einerschritten.
  Die Integration liest die Grenzen trotzdem vom Gerät statt sie fest einzubauen.
- **Feature-Kategorien.** Eine Kategorie, die Gladys nicht kennt, lässt es das GANZE
  Gerät verwerfen (`devices[0].features[n].category: unknown category`), und die
  Gerätesuche bleibt leer.
- **Noch nicht am Gerät getestet.** Der ganze Code ist gegen die Spezifikation gebaut
  und durch Lint und Tests gelaufen, aber noch nie mit einer echten Wallbox verbunden.
