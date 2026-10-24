# Changelog

## [0.6.3] - 2026-10-24

## [0.6.2] - 2026-10-24

## [0.6.1] - 2026-10-24

## [0.5.1] - 2026-10-24

## [0.5.0] - 2026-10-24

## [0.4.0] - 2026-10-24

## [0.3.3] - 2026-10-24

## [0.3.2] - 2026-10-24

## [0.3.1] - 2026-10-24

## [0.3.0] - 2026-10-23

## [0.2.1] - 2026-10-23

## [0.2.0] - 2026-10-23

Alle nennenswerten Änderungen dieser Integration.

## [0.1.1] - 2026-10-23

## [0.1.0] - 2026-10-23

Erste Fassung.

- Modbus-TCP-Anbindung der Vestel EVC04 über Port 502 und Unit ID 255.
- Gerät mit allen Werten, die das Gerät beantwortet: Ladezustand, Kabelzustand,
  Gerätezustand, Fehlercode, Ströme und Spannungen je Phase, Leistung gesamt und je
  Phase, Zählerstand, Energie und Dauer der laufenden Ladung.
- Die Grenzwerte des Geräts (minimaler und maximaler Ladestrom, Kabel-Maximum) sind
  sichtbar und nur lesbar: was in der Wallbox eingestellt ist, gilt.
- Der Ladestrom ist das einzige schreibbare Feature. Ein Sollwert wird gegen die
  Grenzen des Geräts geklemmt, und der Alive-Register wird bedient, solange ein
  Sollwert gilt.
- Kachel „Wallbox“ mit dem Ladezustand in Worten, der Live-Leistung, dem Ladestrom
  mit Zahl und den Knöpfen −1 A, +1 A und Freigeben.
- Szenenauslöser „Wallbox lädt“ und „Wallbox beendet“, beide auf der Flanke.
- Szenenaktionen „Ladestrom setzen“ und „Ladestrom freigeben“.
