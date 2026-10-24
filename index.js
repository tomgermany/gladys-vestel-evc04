// -----------------------------------------------------------------------------
// The entry point: wiring, and nothing else.
//
// WHAT THIS FILE IS FOR
// The integration container is started by the Gladys supervisor and lives as
// long as Gladys does. This file is what the supervisor runs (`"main"` in
// package.json, `node index.js`). It owns the two objects that have a lifetime:
// the Modbus connection and the alive heartbeat. Everything else is a pure
// function called on demand.
//
// ONE CONNECTION, FOR AS LONG AS THE CONTAINER RUNS
// The EVC04 specification allows exactly one Modbus master at a time, so there
// is one `Evc04Client` here and it is never replaced while the process runs. The
// connection test does NOT open a second socket — it runs on this one. A poll
// does not open a socket either: `ModbusSocket.request()` opens the socket on
// the first request and keeps it.
//
// THE HEARTBEAT RUNS WHILE A CURRENT IS SET, NOT WHILE THE PROCESS RUNS
// This is the one place where "live as long as Gladys lives" needs a qualifier,
// and it is not a shortcut. The alive register (6000) is what keeps OUR setpoint
// in force. With no setpoint of ours there is nothing to keep in force, and the
// wallbox works from its own configuration — which is the state the user had
// before this integration existed. Writing the alive register permanently would
// override the wallbox's own behaviour for no reason and make this container
// hard to uninstall cleanly.
//
// So: the heartbeat starts when a current is set and stops when it is released,
// and on shutdown it stops either way. That is the device's own model, not a
// compromise: `AliveControl` is built exactly this way.
//
// HANDLERS ARE REGISTERED BEFORE ANY CONNECTION
// The SDK dispatches on the handlers it has been given, so every handler is
// registered first and the connection is opened afterwards. A device that is
// slow to answer then slows down a poll, instead of delaying the integration's
// startup and making Gladys report it as unavailable.
// -----------------------------------------------------------------------------

import { GladysIntegration } from '@gladysassistant/integration-sdk';
import { DEFAULT_CONFIG, normalizeConfig } from './src/config.js';
import { Evc04Client } from './src/vestel/client.js';
import { AliveControl } from './src/alive.js';
import { buildDevice, publishAll, PLATFORM_TYPE } from './src/devices/wallbox.js';
import { buildChargerContent, CHARGER_WIDGET, chargerAction } from './src/widgets.js';
// `TRIGGER` is deliberately not imported here: the event keys come out of
// `chargingEvents()` as `event.key`, so nothing in this file needs the trigger
// names themselves. Importing them only produced an unused variable.
import { SCENE_ACTIONS, chargingEvents } from './src/scenes.js';
import { t, deviceSentence } from './src/labels.js';
import { CONTROL } from './src/vestel/registers.js';

const gladys = new GladysIntegration();

/** The configuration in force, replaced on every change. */
let config = normalizeConfig(DEFAULT_CONFIG);

/** The one connection of this process. Built once, never replaced. */
const client = new Evc04Client({
  host: config.host,
  port: config.modbus_port,
  unitId: config.unit_id,
});

/** The heartbeat. Its `write` goes through the same connection as everything else. */
const control = new AliveControl({
  write: (register, value) => client.writeRegister(register, value),
  log: (message) => gladys.log(message),
});

/**
 * The last reading, the last charging flank, and the last serial we saw.
 *
 * `previousCharging` is `null` on purpose: after a restart the integration does
 * not know whether a car was already charging, and firing "started" for a
 * session that began before the restart would be a lie about when it began.
 * `src/scenes.js` implements exactly that rule.
 */
let snapshot = null;
let previousCharging = null;
let deviceInfo = { serial: null, model: null };

/**
 * Point the connection at the configured address.
 *
 * A host change cannot be applied to a live socket, so the old one is closed
 * first — and the close is awaited. With a single allowed master, a socket left
 * behind can keep the wallbox from answering the next start.
 */
async function applyConfig(next) {
  config = next;
  client.host = config.host;
  client.port = config.modbus_port;
  client.unitId = config.unit_id;
  control.configure({
    failsafeCurrent: config.failsafe_current,
    failsafeTimeout: config.failsafe_timeout,
  });
  await client.transport.close();
  snapshot = null;
  previousCharging = null;
}

/**
 * Read the device once and bring everything up to date.
 *
 * THE ORDER MATTERS: the events are worked out from the reading BEFORE the
 * reading is published, so a scene that reacts to "charging started" reads the
 * power of the session that just started rather than the one before it.
 */
async function poll() {
  const reading = await client.readAll();
  snapshot = reading;

  const { events, side } = chargingEvents({ snapshot: reading, previous: previousCharging });
  previousCharging = side;
  for (const event of events) {
    gladys.emitEvent(event.key, event.data);
  }

  await publishAll(gladys, { ...deviceInfo }, reading);
  return reading;
}

/**
 * Which features this device offers, asked before anything is read.
 *
 * A discovery that answers nothing is a discovery the user cannot act on, so
 * this reads the identity block and then offers one wallbox. If the address is
 * wrong, `buildDevice` is never reached and the error is the one from the
 * connection — which names host and port, and is the message a user needs.
 */
gladys.onScan(async () => {
  const info = await client.connect();
  deviceInfo = {
    serial: info.serial || null,
    model: info.model || null,
    name: 'Wallbox',
    host: config.host,
  };
  const limits = await client.readLimits().catch(() => null);
  return [buildDevice(gladys, deviceInfo, await client.readAll(), config.poll_frequency, limits)];
});

/** Called by the supervisor when the user creates the device in Gladys. */
gladys.onDeviceCreated?.(async (device) => {
  deviceInfo = { ...deviceInfo, ...device };
});

/** One poll, on the rate the user chose. */
gladys.onPoll(async () => {
  await poll();
  return { should_poll: true, poll_frequency: config.poll_frequency };
});

/**
 * The connection test the configuration screen offers.
 *
 * It reads the device and says what came back, in words a user can act on. It
 * uses the ONE connection: calling `client.connect()` on a live socket would be
 * a second master, which this device does not allow.
 */
gladys.onAction('test_connection', async () => {
  const info = await client.connect();
  const state = await client.readChargepointState();
  const limits = await client.readLimits();
  return {
    serial: info.serial || null,
    model: info.model || null,
    firmware: info.firmware || null,
    state,
    sentence: deviceSentence({ word: state }),
    min_current: limits.min,
    max_current: limits.max,
  };
});

/** The dashboard card: the sentence, the values, and the two buttons. */
gladys.onWidget(CHARGER_WIDGET, async () => {
  const ids = gladys.externalIds(PLATFORM_TYPE, deviceInfo.serial || deviceInfo.host || config.host);
  return buildChargerContent({
    state: snapshot,
    device: deviceInfo,
    ids: {
      power: ids.feature('power'),
      session_energy: ids.feature('session_energy'),
      meter_reading: ids.feature('meter_reading'),
      charging_current: ids.feature('charging_current'),
    },
    controlled: control.active ? control.current : null,
    t,
    sentence: (state) =>
      deviceSentence({
        word: Evc04Client.stateWord(state, 'chargepoint_state'),
        power: state?.power ?? null,
        faultCode: state?.fault_code ?? null,
      }),
  });
});

/**
 * A tap on + or −.
 *
 * The card worked out the intention; this applies it. The current is read from
 * the snapshot the user is looking at, so two taps in a row give two different
 * values, and the limits come from the DEVICE rather than from the card.
 *
 * The handler takes only `action`. The SDK also passes the feature that was
 * tapped, and this device does not need it: the only one it writes is
 * `charging_current`, and the widest tap is {"-", "+"} on that same card. Taking
 * a parameter nobody reads is how a lint rule gets silenced instead of obeyed.
 */
gladys.onWidgetAction(async ({ action }) => {
  const intent = chargerAction({
    actionKey: action?.key,
    params: action?.params,
    state: snapshot,
    limits: client.getLimits(),
    t,
  });
  await client.writeRegister(CONTROL.charging_current, intent.current);
  control.set(intent.current);
  await poll();
  return { toast: intent.toast };
});

/** The one scene action: set the charging current, with the heartbeat kept alive. */
gladys.onSceneAction('set_charging_current', async (fields) => {
  return SCENE_ACTIONS.set_charging_current({ client, fields, control });
});

/**
 * Shutdown.
 *
 * This is where a single-master device is left clean. The heartbeat is stopped
 * first — so no write can be in flight — and the socket is then closed AND
 * WAITED FOR. `reset()` would return at once and leave the wallbox counting a
 * master for a moment, which is exactly what a restart cannot afford.
 */
async function shutdown() {
  control.clear();
  control.stop();
  await client.transport.close();
  gladys.log('Verbindung zur Wallbox geschlossen.');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shutdown().finally(() => process.exit(0));
  });
}

/**
 * Startup.
 *
 * The handlers above are registered before this runs. A device that does not
 * answer does not stop the integration from starting: the supervisor would
 * otherwise report it as unavailable, and the user could not reach the
 * configuration that fixes the address.
 */
async function main() {
  config = normalizeConfig(await gladys.getConfig());
  await applyConfig(config);
  gladys.onConfigUpdated(async (next) => {
    await applyConfig(normalizeConfig(next));
  });
  gladys.log(`Vestel EVC04 Integration bereit (${config.host || 'keine Adresse'}).`);
}

main().catch((err) => {
  gladys.log(`Start fehlgeschlagen: ${err.message}`);
});
