# Vestel EVC04 Wallbox

 Eine externe [Gladys Assistant](https://gladysassistant.com/)-Integration f\u00fcr die Ladestation
**Vestel EVC04 Home** \u00fcber Modbus TCP/IP. Rein lokal: kein Cloud, kein OCPP-Backend, kein Konto.

## Warum Modbus und nicht OCPP

 Die Wallbox bietet drei Wege: die Hersteller-Cloud, OCPP 1.6, und Modbus TCP.

OCPP ist ein Protokoll zwischen einer Ladestation und einem **Backend**. Im Heimgebrauch hie\u00dfe das,
selbst einen Server zu betreiben, der Vertr\u00e4ge, Authentifizierung und Lastmanagement f\u00fchrt \u2014 die
Integration w\u00e4re dann nicht der Endpunkt, sondern ein zweiter Container dazwischen. F\u00fcr \u201elade mit
PV-\u00dcberschuss\u201c ist das ein Umweg ohne Gegenwert.

Modbus ist ein Register auf dem Ger\u00e4t selbst: eine Verbindung, ein Lese- oder Schreibbefehl. Hier
ist es derselbe Weg wie bei der WattW\u00e4chter-Integration.

## Voraussetzungen

- Gladys Assistant **5.1.0 oder neuer**.
- Modbus TCP auf der Wallbox ist aktiviert (Port **502**).
- Der **Modbus Unit ID ist 255**, nicht 1.
- Wallbox und Gladys-Host im selben Netz.

## Der Alive-Register, bevor irgendetwas gesteuert wird

Die Wallbox erwartet, dass der Master in Register `6000` **regelm\u00e4\u00dfig eine 1 schreibt**; sie setzt den
Wert danach selbst auf 0 zur\u00fcck. Bleibt das aus, schaltet sie auf den **Failsafe-Strom** um.

Das Zeitfenster gibt `2002` (Failsafe Timeout, Standard 20 s) vor: solange eine Steuerung aktiv ist,
wird der Alive-Register in der **halben** Timeout-Zeit bedient, mindestens alle 3 s. Ohne diesen
Herzschlag f\u00e4llt jede Ladestrom-Vorgabe auf den Failsafe-Wert zur\u00fcck \u2014 das ist keine Feinheit,
sondern die Grundbedingung f\u00fcr gesteuertes Laden.

## Nur EINE Modbus-Verbindung

Der Hersteller sagt es ausdr\u00fccklich: es kann zu jedem Zeitpunkt nur **ein** Modbus-Master verbunden
sein (beim WattW\u00e4chter sind es zwei Slots). Deshalb besitzt dieser Prozess genau eine Verbindung,
und auch der Verbindungstest benutzt sie mit, statt eine zweite aufzumachen.

## Registerkarte

Die Adressangaben im Herstellerdokument sind vermutlich **Dokumentadressen**, nicht die Adressen auf
der Leitung. Ob ein Register unter `1008` oder `1007` liegt, muss am Ger\u00e4t entschieden werden; die
Registerkarte h\u00e4lt die Adressen deshalb in `src/vestel/registers.js` an einer Stelle.

## Entwicklung

```bash
npm install
npm test
npm run lint
node index.js
```

- `index.js` verdrahtet nur: jeder Handler wird vor der Verbindung registriert.
- `src/vestel/transport.js` ist der rohe TCP-Socket (MBAP-Rahmen, Slots, Schlie\u00dfen vor \u00d6ffnen).
- `src/vestel/modbus.js` ist das Protokoll.
- `src/vestel/registers.js` ist die Registerkarte der EVC04.
- `src/devices/wallbox.js` macht die Wallbox zu einem Gladys-Ger\u00e4t.
- `src/widgets.js` baut den Inhalt der Kachel.
- `src/scenes.js` h\u00e4lt die Szenenausl\u00f6ser und -aktionen.
- `src/alive.js` ist der Herzschlag f\u00fcr den Alive-Register.

## Lizenz

Apache-2.0.
