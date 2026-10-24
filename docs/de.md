# Vestel EVC04 Home – Gladys-Assistant-Integration

Diese Community-Integration verbindet eine Vestel-EVC04-Home-Wallbox über **Modbus TCP** mit [Gladys Assistant](https://gladysassistant.com/). Sie liest Lademesswerte aus und steuert den erlaubten Ladestrom lokal. Eine Hersteller-Cloud, ein OCPP-Backend oder ein Benutzerkonto sind nicht erforderlich.

## Voraussetzungen

- Gladys Assistant **5.1.0 oder neuer**.
- Modbus TCP ist an der Wallbox aktiviert.
- Wallbox und Gladys-Host sind im selben Netzwerk erreichbar.
- Standard-Modbus-Port: **502**; Standard-Unit-ID: **255**.

Die EVC04 unterstützt nur **einen Modbus-Master gleichzeitig**. Die Integration nutzt deshalb eine gemeinsame Verbindung für Messwerte, Verbindungstests und Steuerbefehle. Es darf nicht gleichzeitig ein zweiter Modbus-Client mit der Wallbox verbunden sein.

## Installation und Konfiguration

Installiere die Integration über das Integrationssystem von Gladys. Das Container-Image wird hier veröffentlicht:

`ghcr.io/tomgermany/gladys-vestel-evc04:latest`

Konfiguriere die IP-Adresse oder den mDNS-Namen der Wallbox (ohne `http://`), den Modbus-Port, die Unit-ID, das Messwert-Aktualisierungsintervall und die Heartbeat-Frist. Für eine stabile Adresse empfiehlt sich eine DHCP-Reservierung.

| Einstellung | Standard | Beschreibung |
| --- | --- | --- |
| Wallbox-Adresse | — | IP-Adresse oder mDNS-Name |
| Modbus-Port | `502` | Nur ändern, wenn ein anderer Port verwendet wird |
| Modbus-Unit-ID | `255` | Standardwert der EVC04 |
| Aktualisierungsintervall | 5 Minuten | Möglich sind 1, 5, 15, 30 oder 60 Minuten |
| Heartbeat-Frist | 20 Sekunden | Gilt bei aktiver Ladestromsteuerung |

Nach dem Speichern kannst du mit **Verbindung prüfen** die Kommunikation über die bestehende Verbindung testen.

## Messwerte und Aktualisierung

Die Integration stellt Ladezustand, Leistung, Strom, Spannung und Energie in Gladys bereit. Das Aktualisierungsintervall bestimmt, wie oft diese Werte neu eingelesen werden. Ein fehlgeschlagener Lesevorgang wird protokolliert; anschließend versucht die Integration einmal, über einen neuen Socket wieder eine Verbindung herzustellen. Bei fünf Minuten Intervall kann ein Verbindungsproblem erst bei der nächsten regulären Abfrage auffallen.

## Ladestromsteuerung und Heartbeat

Der erlaubte Ladestrom wird über das Modbus-Register `5004` eingestellt. Die Wallbox besitzt keinen separaten Start-/Stopp-Befehl. Ob geladen wird, hängt davon ab, ob das Fahrzeug Strom aufnimmt.

- Der Sollstrom wird auf mindestens **6 A** und höchstens auf den von Wallbox und Kabel erlaubten Wert begrenzt.
- Das Dashboard-Widget bietet Tasten zum Erhöhen und Verringern des Ladestroms. Die Schrittweite kann je Widget auf **1, 2 oder 5 A** eingestellt werden.
- Gladys-Szenen können mit der Aktion **Ladestrom setzen** einen Wert vorgeben.
- Während eine Ladestromvorgabe aktiv aufrechterhalten wird, sendet die Integration über Register `6000` einen Heartbeat. Bei der Standardfrist von 20 Sekunden geschieht dies ungefähr alle 10 Sekunden, mindestens jedoch im Abstand von 3 Sekunden.
- Bleibt der Heartbeat aus, fällt die Wallbox auf ihren Failsafe-Strom zurück. Der Heartbeat ist unabhängig vom Messwertintervall und kann eine festgefahrene Wallbox nicht neu starten.

## Gladys-Szenen

Es gibt zwei Ereignisse:

- **Wallbox lädt** – wird beim Wechsel in den Ladezustand ausgelöst.
- **Wallbox beendet** – wird beim Wechsel aus dem Ladezustand ausgelöst.

Je nach Ereignis stehen Variablen wie Leistung, Ladestrom, Zählerstand, Sitzungsenergie und Dauer zur Verfügung. Szenen können außerdem die Aktion **Ladestrom setzen** verwenden.

## Fehlerbehebung

- **Keine Antwort:** Prüfe die Adresse, die Netzwerkverbindung und die Aktivierung von Modbus TCP.
- **Falsche Unit-ID:** Der Standardwert ist `255`, nicht `1`.
- **Verbindung belegt:** Trenne andere Modbus-Clients von der EVC04.
- **Messwerte sind veraltet:** Prüfe das Aktualisierungsintervall oder führe **Verbindung prüfen** aus.
- **Wallbox reagiert nicht mehr:** Der Heartbeat kann den Failsafe-Strom aktivieren, aber die Integration kann die Wallbox nicht aus- und einschalten oder einen Firmware-Hänger beheben.

## Hersteller- und Markenhinweis

Dies ist eine unabhängige Community-Integration für Gladys Assistant. Sie wird weder von Vestel entwickelt noch unterstützt oder offiziell freigegeben. **Vestel** und **EVC04** sind Herstellerbezeichnungen. Marken, Logos und Produktdarstellungen gehören ihren jeweiligen Rechteinhabern und dienen ausschließlich der Identifikation des unterstützten Produkts.

## Lizenz

Apache-2.0.
