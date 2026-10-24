# Vestel EVC04 Home – Gladys Assistant integration

This community integration connects a Vestel EVC04 Home wallbox to [Gladys Assistant](https://gladysassistant.com/) using **Modbus TCP**. It reads charging measurements and controls the permitted charging current locally. It does not require the manufacturer's cloud, an OCPP backend, or a user account.

## Requirements

- Gladys Assistant **5.1.0 or newer**.
- Modbus TCP enabled on the wallbox.
- The wallbox and Gladys host must be reachable on the same network.
- Default Modbus TCP port: **502**. Default Unit ID: **255**.

The EVC04 supports only **one Modbus master at a time**. This integration shares a single connection for measurements, connection tests, and control commands. Do not connect another Modbus client to the wallbox at the same time.

## Installation and configuration

Install the integration through the Gladys integrations system. The container image is published as:

`ghcr.io/tomgermany/gladys-vestel-evc04:latest`

Configure the wallbox IP address or mDNS name (without `http://`), Modbus port, Unit ID, measurement polling interval, and heartbeat deadline. A DHCP reservation is recommended for a stable wallbox address.

| Setting | Default | Description |
| --- | --- | --- |
| Wallbox address | — | IP address or mDNS name |
| Modbus port | `502` | Change only if your wallbox uses another port |
| Modbus Unit ID | `255` | Default EVC04 Unit ID |
| Polling interval | 5 minutes | Supported intervals: 1, 5, 15, 30, or 60 minutes |
| Heartbeat deadline | 20 seconds | Used while charging-current control is active |

After saving the settings, use **Check connection** to test communication over the existing connection.

## Measurements and polling

The integration publishes charging status, power, current, voltage, and energy measurements to Gladys. The polling interval determines how often these values are refreshed. A failed read is logged, and the integration makes one attempt to reconnect using a fresh socket. With a five-minute polling interval, a connectivity problem may not be noticed by regular polling until the next scheduled read.

## Charging-current control and heartbeat

The integration sets the permitted charging current through Modbus register `5004`. The wallbox has no separate start/stop command; charging starts or stops depending on whether the vehicle draws current.

- The requested current is limited to at least **6 A** and to the maximum value permitted by the wallbox and cable.
- The dashboard widget provides increase/decrease controls with a per-widget step of **1, 2, or 5 A**.
- Gladys scenes can set a value using the **Set charging current** action.
- While current control is actively maintained, the integration sends a heartbeat through register `6000`. With the default 20-second deadline, it is sent about every 10 seconds, with a minimum interval of 3 seconds.
- If the heartbeat stops, the wallbox falls back to its failsafe current. Heartbeat timing is independent of measurement polling and cannot reboot a wallbox whose firmware is stuck.

## Gladys scenes

The integration provides **two scene triggers** and **one scene action**.

### Scene triggers

- **Wallbox charging** — triggered when the wallbox transitions into the charging state.
- **Wallbox charging ended** — triggered when it transitions out of the charging state.

Depending on the trigger, variables include measurements such as power, charging current, meter reading, session energy, and duration.

### Scene action

- **Set charging current** — a scene can use this action to request a charging-current value in amperes. The value is limited to a minimum of **6 A** and the maximum permitted by the wallbox and cable.

## Troubleshooting

- **No response:** Check the wallbox address, network connectivity, and whether Modbus TCP is enabled.
- **Unexpected Unit ID:** The default is `255`, not `1`.
- **Connection is busy:** Make sure no other Modbus client is connected to the EVC04.
- **Measurements seem stale:** Check the polling interval or run **Check connection**.
- **Wallbox is unresponsive:** The heartbeat can cause the failsafe current to be used, but the integration cannot power-cycle a wallbox or recover a firmware lockup.

## Manufacturer and trademark notice

This is an independent community integration for Gladys Assistant. It is not developed, endorsed, or officially supported by Vestel. **Vestel** and **EVC04** are manufacturer designations. Trademarks, logos, and product representations belong to their respective owners and are used only to identify the supported product.

## License

Apache-2.0.
