import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { DEFAULT_CONFIG, normalizeConfig } from './src/config.js';
import { Evc04Client } from './src/vestel/client.js';
import { AliveControl } from './src/alive.js';
import { buildDevice, publishAll, PLATFORM_TYPE } from './src/devices/wallbox.js';
// `chargerAction` is deliberately not imported here. The SDK delivers a setpoint
// through `onSetValue`, so the setpoint is clamped in the handler from the device's
// own limits — the widget-returning mechanism is not part of that surface. The
// function and its tests stay in src/widgets.js, because removing them is a decision
// about the tests, not a side effect of an import.
import { buildChargerContent, CHARGER_WIDGET, CURRENT_READING } from './src/widgets.js';
// `TRIGGER` is deliberately not imported here: the event keys come out of
// `chargingEvents()` as `event.key`, so nothing in this file needs the trigger names
// themselves. Importing them only produced an unused variable.
import { SCENE_ACTIONS, chargingEvents } from './src/scenes.js';
import { t, deviceSentence } from './src/labels.js';
import { CONTROL } from './src/vestel/registers.js';

/**
 * LOGGING: `logger`, NOT `gladys.log`
 *
 * The SDK exports a leveled logger as its own export (`logger`, or a named one from
 * `createLogger({ name })`); `debug`/`info` go to stdout and `warn`/`error` to
 * stderr, and the Gladys supervisor captures both.
 *
 * `gladys.log(...)` DOES NOT EXIST. An earlier version of this file called it four
 * times, including in the `catch` of main() — so the container died while trying to
 * report a failure, and the failure itself was never printed. That is the reason the
 * installation failed "without an error message": the message was what crashed.
 */
const log = logger;

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
  log: (message) => log.warn(message),
});

/**
 * The last reading, the last charging flank, and the identity of the device.
 *
 * `previousCharging` is `null` on purpose: after a restart the integration does not
 * know whether a car was already charging, and firing "started" for a session that
 * began before the restart would be a lie about when it began.
 */
let snapshot = null;
let previousCharging = null;
let deviceInfo = { serial: null, model: null };

/** The device external id as the SDK builds it, never by hand. */
function deviceIds() {
  return gladys.externalIds(PLATFORM_TYPE, deviceInfo.serial || deviceInfo.host || config.host);
}

/**
 * Point the connection at the configured address.
 *
 * A host change cannot be applied to a live socket, so the old one is closed first —
 * and the close is awaited. With a single allowed master, a socket left behind can
 * keep the wallbox from answering the next start.
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
 * THE ORDER MATTERS: the events are worked out from the reading BEFORE the reading is
 * published, so a scene that reacts to "charging started" reads the figures of the
 * session that just started rather than the one before it.
 */
async function poll() {
  const reading = await client.readAll();
  snapshot = reading;

  const { events, side } = chargingEvents({ snapshot: reading, previous: previousCharging });
  previousCharging = side;
  for (const event of events) {
    await gladys.publishSceneEvent(event.key, event.data);
  }

  await publishAll(gladys, { ...deviceInfo }, reading);
  return reading;
}

/**
 * Which devices this integration offers, when Gladys asks.
 *
 * The callback answers with the list of devices. A discovery that answers nothing is
 * one the user cannot act on, so this reads the identity block and then offers one
 * wallbox. If the address is wrong, the error is the one from the connection — which
 * names host and port, and is the message a user needs.
 */
gladys.onScanRequest(async () => {
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

/** One poll, on the rate the user chose. */
gladys.onPoll(async () => {
  await poll();
  return { should_poll: true, poll_frequency: config.poll_frequency };
});

/**
 * A setpoint from Gladys: the value of the one writable feature changed.
 *
 * `onSetValue` is the SDK's handler for a command, and it arrives with the device,
 * the feature and the value. The value is written to register 5004, the heartbeat is
 * told to keep it in force, and the device is read once so the card shows what the
 * wallbox reports rather than what was asked for.
 */
gladys.onSetValue(async (device, deviceFeature, value) => {
  const wanted = Number(value);
  if (!Number.isFinite(wanted)) throw new Error('Der Ladestrom muss eine Zahl sein');

  const limits = client.getLimits();
  const current = Math.min(limits.max, Math.max(limits.min, Math.round(wanted)));

  await client.writeRegister(CONTROL.charging_current, current);
  control.set(current);
  await poll();
  return { toast: t('control', current) };
});

/**
 * The connection test the configuration screen offers.
 *
 * It reads the device and says what came back, in words a user can act on. It uses
 * the ONE connection: opening a second one would be a second master, which this
 * device does not allow.
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

/**
 * The dashboard card.
 *
 * The content is built from the last snapshot, so a card opened between two polls
 * shows the reading that was really taken rather than a number invented here. The id
 * passed to the tile is the one feature this device publishes.
 */
gladys.onWidgetGet(CHARGER_WIDGET, async () => {
  const ids = deviceIds();
  return buildChargerContent({
    state: snapshot,
    device: deviceInfo,
    ids: { charging_current: ids.feature(CURRENT_READING) },
    controlled: control.active ? control.current : null,
    t,
    sentence: (state) =>
      deviceSentence({
        word: Evc04Client.stateWord(state, 'chargepoint_state'),
        power: Evc04Client.reading(state, 'power'),
        faultCode: Evc04Client.reading(state, 'fault_code'),
      }),
  });
});

/** The one scene action: set the charging current, with the heartbeat kept alive. */
gladys.onSceneAction('set_charging_current', async (fields) => {
  return SCENE_ACTIONS.set_charging_current({ client, fields, control });
});

/**
 * The connection status in the Configuration screen.
 *
 * A wallbox that does not answer is not a broken integration: the container is up and
 * only the device is unreachable, which is exactly what a user needs told. The call is
 * best effort — losing the status line must not stop startup.
 */
async function reportConnection() {
  try {
    await client.readOptionalUint16(CONTROL.charging_current);
    await gladys.setConnectionStatus(true);
  } catch (err) {
    await gladys.setConnectionStatus(false, {
      de: `Keine Verbindung zur Wallbox: ${err.message}`,
      en: `No connection to the wallbox: ${err.message}`,
    });
  }
}

/**
 * Shutdown.
 *
 * `handleShutdown` is the SDK's own path: it runs this cleanup, disconnects cleanly
 * and exits. The heartbeat is stopped first, so no write can be in flight, and the
 * socket is then closed AND WAITED FOR — `reset()` would return at once and leave the
 * wallbox counting a master for a moment, which is exactly what a restart cannot
 * afford.
 */
gladys.handleShutdown(async () => {
  control.clear();
  control.stop();
  await client.transport.close();
  log.info('Verbindung zur Wallbox geschlossen.');
});

/**
 * Startup.
 *
 * Every handler is registered before this runs, and `connect()` comes after the
 * configuration, because a handler that is missing when the first command arrives is a
 * command that is silently dropped.
 */
async function main() {
  config = normalizeConfig(await gladys.getConfig());
  await applyConfig(config);
  gladys.onConfigUpdated(async (next) => {
    await applyConfig(normalizeConfig(next));
  });
  await gladys.connect();
  log.info(`Vestel EVC04 Integration bereit (${config.host || 'keine Adresse'}).`);
  await reportConnection();
}

main().catch((err) => {
  // A failure here must not take the container down with a second failure. This is
  // the line that used to crash, because it called a method the SDK does not have.
  log.error('Start fehlgeschlagen', err);
});
