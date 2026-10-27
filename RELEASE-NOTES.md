# v1.1.0

[Deutsch](#deutsch) · [English](#english)

---

## Deutsch

### Behobener Fehler: Wallbox lädt nach Neustart nur noch mit 6 A

In früheren Versionen schrieb die Integration bei jedem Setzen des Ladestroms (Widget, Szene, Gerätewert) den Failsafe-Strom mit dem Standardwert 6 A in das **dauerhaft gespeicherte** Register 2000 der Wallbox. Blieb der Herzschlag (Register 6000) danach aus, etwa nach einem Neustart, Stopp oder Absturz von Gladys, fiel die Wallbox nach dem Timeout auf diesen Wert zurück. Sie lud dann dauerhaft mit 6 A, auch wenn Hersteller-App oder Web-Oberfläche mehr erlaubten.

### Änderungen

- Der Failsafe-Strom ist jetzt standardmäßig **16 A** (begrenzt auf das Maximum, das die Wallbox meldet).
- Die Failsafe-Register 2000 und 2002 werden nur noch **geschrieben, wenn sie vom gewünschten Wert abweichen**, nicht mehr bei jedem Ladestrom-Befehl.
- Die Herzschlag-Frist (Register 2002) beträgt mindestens 6 Sekunden. Leere oder ungültige Werte führen nicht mehr zu 0.
- Register, die 0 melden (z. B. Kabel- oder Sitzungsmaximum), senken die Obergrenze nicht mehr auf 6 A. Das Sitzungsmaximum (Register 1100) fließt nicht mehr in die Obergrenze ein.
- Die Tasten + und − im Widget gehen jetzt vom gemessenen **Strom pro Phase** aus, nicht mehr von der Summe der drei Phasen.
- Der Kabel-Hinweis im Widget erscheint nur noch bei gültigen Werten.
- Neue Tests für Failsafe-Standardwerte und Grenzwert-Berechnung.

### Wichtig: geändertes Verhalten bei Ausfall von Gladys

Fällt Gladys aus, lädt die Wallbox nach etwa 20 Sekunden mit dem Failsafe-Strom weiter, jetzt **16 A statt 6 A**. Wenn deine Installation weniger als 16 A verträgt, prüfe das vor dem Update. Der Failsafe-Strom lässt sich in der Oberfläche der Integration nicht einstellen.

### Betroffen? So prüfst du es

1. Gladys-Integration stoppen (die Wallbox erlaubt nur einen Modbus-Master).
2. Mit einem Modbus-Tool (Unit ID 255, Funktion 03) die Register **2000** und **2002** lesen.
3. Stehen dort 6 und 0 (oder 6 und ein anderer unerwarteter Wert), war die Wallbox betroffen. Mit dieser Version sollten beide beim nächsten Setzen des Ladestroms auf 16 und 20 korrigiert werden. Alternativ lassen sie sich per Funktion 06 direkt zurückschreiben.

### Bekannte Einschränkungen

- Modell, Firmware und Seriennummer werden bei manchen Geräten falsch oder leer angezeigt.
- Der angezeigte Zählerstand („Gesamtverbrauch“) ist noch nicht verlässlich.
- Die Kachel „Ladestrom gesamt“ im Widget zeigt in manchen Fällen einen Wert, der nicht zur Leistungsanzeige passt.
- Die Diagnose-Logs (`Current-limit diagnostic`, `Charging diagnostic`, `MODBUS TRACE`) sind vorübergehend noch aktiv.

An diesen Punkten wird in einem eigenen Branch gearbeitet.

---

## English

### Fixed: wallbox only charges at 6 A after a restart

Earlier versions wrote the failsafe current, defaulting to 6 A, into the wallbox's **persistent** register 2000 every time a charging current was set (widget, scene, device value). When the heartbeat (register 6000) then stopped, for example after Gladys was restarted, stopped or crashed, the wallbox fell back to that value after its timeout. It then kept charging at 6 A, even when the manufacturer's app or web interface allowed more.

### Changes

- The failsafe current now defaults to **16 A** (limited to the maximum the wallbox reports).
- The failsafe registers 2000 and 2002 are now **written only when they differ** from the wanted value, no longer on every charging-current command.
- The heartbeat deadline (register 2002) is at least 6 seconds. Empty or invalid values no longer end up as 0.
- Registers that report 0 (for example the cable or session maximum) no longer lower the ceiling to 6 A. The session maximum (register 1100) is no longer part of the ceiling.
- The + and − buttons on the widget now start from the measured **per-phase current**, not the sum of the three phases.
- The cable limit hint on the widget only appears for valid values.
- New tests for the failsafe defaults and the limit calculation.

### Important: changed behaviour when Gladys goes down

If Gladys goes down, the wallbox keeps charging after about 20 seconds at the failsafe current, now **16 A instead of 6 A**. If your installation cannot take 16 A, check this before updating. The failsafe current cannot be set in the integration's configuration.

### Affected? How to check

1. Stop the Gladys integration (the wallbox allows only one Modbus master).
2. With a Modbus tool (unit ID 255, function 03), read registers **2000** and **2002**.
3. If they show 6 and 0 (or 6 and another unexpected value), your wallbox was affected. With this version both should be corrected to 16 and 20 the next time a charging current is set. Alternatively, write them back directly with function 06.

### Known limitations

- Model, firmware and serial number are shown wrongly or empty on some devices.
- The displayed meter reading is not yet reliable.
- The "total charging current" tile on the widget sometimes shows a value that does not match the power display.
- The diagnostic logs (`Current-limit diagnostic`, `Charging diagnostic`, `MODBUS TRACE`) are temporarily still active.

These are being worked on in a separate branch.
