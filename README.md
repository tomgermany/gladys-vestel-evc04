# Vestel EVC04 Wallbox

Externe [Gladys Assistant](https://gladysassistant.com/)-Integration für die **Vestel EVC04 Home**. Sie liest Messwerte aus und steuert den erlaubten Ladestrom über **Modbus TCP** – vollständig lokal, ohne Hersteller-Cloud, OCPP-Backend oder Benutzerkonto.

## Dokumentation

- [English](docs/en.md)
- [Français](docs/fr.md)
- [Deutsch](docs/de.md)
- [Español](docs/es.md)

## Funktionen

- Wallbox als Gerät in Gladys entdecken und Messwerte veröffentlichen.
- Ladezustand, Leistung, Strom, Spannung und Energie erfassen.
- Ladestrom über die Wallbox-Kachel, eine Gladys-Szene oder die Aktion **„Ladestrom setzen“** einstellen.
- Szenenereignisse beim Beginn und Ende eines Ladevorgangs auslösen.
- Verbindung über die Aktion **„Verbindung prüfen“** testen.
- Aktualisierungsintervall passend zum eigenen Bedarf einstellen.

## Voraussetzungen

- Gladys Assistant **5.1.0 oder neuer**.
- Modbus TCP ist in der Wallbox aktiviert.
- Wallbox und Gladys-Host sind im selben Netzwerk erreichbar.
- Standardmäßig verwendet die Wallbox Modbus-Port **502** und Unit ID **255**.

Die EVC04 erlaubt nur **einen Modbus-Master gleichzeitig**. Diese Integration verwendet deshalb eine einzige Verbindung für Messungen, Verbindungstest und Steuerbefehle. Bitte nicht parallel einen zweiten Modbus-Client mit der Wallbox verbinden.

## Installation und Konfiguration

Installiere die Integration in Gladys über das Integrationssystem. Das Container-Image wird unter folgender Adresse veröffentlicht:

`ghcr.io/tomgermany/gladys-vestel-evc04:latest`

Trage anschließend in der Integrationskonfiguration ein:

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Adresse der Wallbox | – | IP-Adresse oder mDNS-Name, ohne `http://`; eine feste IP per DHCP-Reservierung ist empfehlenswert |
| Modbus-Port | `502` | Nur ändern, wenn die Wallbox einen anderen Port verwendet |
| Modbus Unit ID | `255` | Die EVC04 antwortet standardmäßig auf Unit ID 255 |
| Aktualisierungsintervall | `5 Minuten` | Messwerte werden alle 1, 5, 15, 30 oder 60 Minuten gelesen und an Gladys übergeben |
| Herzschlag-Frist | `20 Sekunden` | Bestimmt den Takt des Alive-Registers während aktiver Ladestromsteuerung |

Nach dem Speichern kannst du **„Verbindung prüfen“** verwenden. Die Integration liest die Wallbox über ihre bestehende Verbindung aus und meldet, ob sie geantwortet hat.

## Aktualisierung und Erreichbarkeit

Das Aktualisierungsintervall steuert, wie oft Messwerte neu gelesen und in Gladys aktualisiert werden. Die Abfrage erfolgt im Minutenraster; das gewählte Intervall wird durch Überspringen dazwischenliegender Ticks umgesetzt.

Ein fehlgeschlagener Lesevorgang wird protokolliert und die Integration versucht einmal, die Verbindung über einen frischen Socket wiederherzustellen. Bei einem Intervall von fünf Minuten kann es bis zur nächsten Abfrage dauern, bis ein Erreichbarkeitsproblem durch das reguläre Polling auffällt. Die Integration kann eine vollständig festgefahrene Wallbox nicht durch den Heartbeat neu starten.

## Ladestrom und Heartbeat

Die Wallbox hat keinen separaten Start-/Stopp-Befehl für den Ladevorgang. Die Integration stellt den erlaubten Ladestrom über Register `5004` ein. Der Ladevorgang beginnt oder endet abhängig davon, ob das Fahrzeug Strom aufnimmt.

- Der Ladestrom wird auf mindestens **6 A** und höchstens auf den von Wallbox und Kabel gemeldeten zulässigen Wert begrenzt.
- Die Dashboard-Kachel enthält Schaltflächen zum Verringern und Erhöhen des Ladestroms. Die Schrittweite lässt sich pro Kachel auf **1, 2 oder 5 A** einstellen.
- Szenen können über **„Ladestrom setzen“** einen Wert vorgeben.
- Solange eine Ladestromvorgabe aktiv gesteuert wird, hält die Integration den Heartbeat über Register `6000` aufrecht. Bei einer Standardfrist von 20 Sekunden erfolgt dies etwa alle 10 Sekunden, mindestens jedoch im Abstand von 3 Sekunden.
- Wenn der Heartbeat ausbleibt, fällt die Wallbox auf ihren Failsafe-Strom zurück. Der Heartbeat ist unabhängig vom Messwert-Aktualisierungsintervall und ersetzt keine Neustartfunktion.

## Szenen

Die Integration stellt zwei Szenenereignisse bereit:

- **Wallbox lädt** – wird beim Übergang in den Ladezustand ausgelöst.
- **Wallbox beendet** – wird beim Übergang aus dem Ladezustand ausgelöst.

Je nach Ereignis stehen Messwerte wie Leistung, Ladestrom, Zählerstand, Sitzungsenergie und Dauer als Variablen bereit. Zusätzlich kann eine Szene mit der Aktion **„Ladestrom setzen“** den gewünschten Strom vorgeben.

## Fehlerbehebung

- **Keine Antwort:** Prüfe IP-Adresse, Netzwerkverbindung und ob Modbus TCP in der Wallbox aktiviert ist.
- **Falsche Unit ID:** Verwende normalerweise `255`, nicht `1`.
- **Verbindung belegt:** Stelle sicher, dass kein anderer Modbus-Client parallel mit der EVC04 verbunden ist.
- **Werte werden nicht sofort aktualisiert:** Prüfe das eingestellte Aktualisierungsintervall oder führe **„Verbindung prüfen“** aus.
- **Die Wallbox reagiert überhaupt nicht mehr:** Der Heartbeat kann den Failsafe-Strom auslösen, aber die Integration kann einen Firmware-Hänger nicht selbst durch Aus- und Einschalten beheben.

## Entwicklung

Voraussetzung ist Node.js **22 oder neuer**.

```bash
npm install
npm test
npm run lint
npm start
```

Wichtige Dateien:

- `index.js` – verbindet die Gladys-Handler mit Client, Gerät, Kachel und Szenen.
- `src/vestel/transport.js` – TCP-Verbindung und Modbus-Transport.
- `src/vestel/modbus.js` – Modbus-Protokoll.
- `src/vestel/registers.js` – Registerdefinitionen der EVC04.
- `src/devices/wallbox.js` – Gladys-Gerät und Messwerte.
- `src/widgets.js` – Inhalt und Bedienlogik der Wallbox-Kachel.
- `src/scenes.js` – Szenenereignisse und Ladestrom-Aktion.
- `src/alive.js` – Heartbeat für die aktive Ladestromsteuerung.
- `src/config.js` – Standardwerte und Normalisierung der Konfiguration.

## Hinweis zu Marken und Hersteller

Dies ist eine unabhängige Community-Integration für Gladys Assistant. Sie wird weder von Vestel entwickelt noch unterstützt oder offiziell freigegeben. **Vestel** und **EVC04** sind Bezeichnungen des jeweiligen Herstellers. Marken, Logos und Produktdarstellungen gehören ihren jeweiligen Rechteinhabern; ihre Nennung dient ausschließlich der Identifikation des unterstützten Produkts.

Weitere Informationen zum Hersteller und zur EVC04-Serie findest du auf der [offiziellen Vestel-eCharger-Website](https://www.vestel-echarger.com/).

## Lizenz

Apache-2.0.
