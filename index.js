// -----------------------------------------------------------------------------
// Entry point (the "wiring"): it connects the pieces and holds no logic.
//
// PORTED FROM THE WATTWAECHTER INTEGRATION, WHICH RUNS
// This file follows the shape of `gladys-wattwaechter/index.js`, because that one is
// a working integration against the same SDK generation and the same Gladys. Three
// mechanisms are taken over whole, and each cost that project a real failure before
// it was fixed:
//
//   THE CONNECT GATE (`connecting`)
//   `connected` and `onConfigUpdated` both connect, and on a restart they fire
//   within seconds of each other. Two competing connect attempts leave two sockets
//   open — on a device that allows ONE Modbus master, the second attempt is the one
//   that fails.
//
//   AN IDEMPOTENT CONNECT (`establish()`)
//   The connection test reads the configuration, that round trip makes Gladys
//   deliver `onConfigUpdated`, and a naive connect path then tears down a working
//   socket to build an equivalent one. Here that is avoided on purpose: a live
//   socket to the same host and port is KEPT, and only the readings are refreshed.
//
//   ONE RETRY ON A FRESH SOCKET (`withConnection()`)
//   A recreated container can meet a slot the device still holds open from the
//   previous run. One deliberate retry rides that out; more would hammer the
//   device.
//
// A HANDLER FOR EVERY MESSAGE, OR GLADYS SAYS "not implemented"
// A widget is not drawn by the integration: Gladys asks for its content and renders
// the answer. With no `onWidgetGet` registered for the widget key, Gladys receives
// the SDK's default answer to an unhandled message — the literal words "not
// implemented" on the card — while every value beside it is right. Both widget
// handlers are therefore registered here, under the key the manifest declares.
//
// THE ONE ORDERING RULE
// Every handler is registered BEFORE `gladys.connect()`, and the configuration is
// read in the `connected` handler — `getConfig()` talks to the host API, so it
// needs an authenticated WebSocket and cannot run earlier.
//
// SDK: @gladysassistant/integration-sdk ^0.15 (Gladys >= 5.1.0).
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';

import { DEFAULT_CONFIG, normalizeConfig } from './src/config.js';
import { Evc04Client } from './src/vestel/client.js';
import { AliveControl } from './src/alive.js';
import {
  buildDevice,
  deviceExternalId,
  platformId,
  publishAll,
  PLATFORM_TYPE,
} from './src/devices/wallbox.js';
// `ACTION` is deliberately not imported here. The tap is worked out by
// `chargerAction` from the action key the SDK delivers, and the keys themselves are
// the card's business — index.js never names one. Importing it only produced an
// unused variable.
import {
  CHARGER_WIDGET,
  buildChargerContent,
  chargerAction,
  TOTAL_CURRENT_READING,
} from './src/widgets.js';
import { SCENE_ACTIONS, chargingEvents } from './src/scenes.js';
import { t, deviceSentence } from './src/labels.js';
import { CONTROL } from './src/vestel/registers.js';

const gladys = new GladysIntegration();

// --- State of the running integration ----------------------------------------
let config = normalizeConfig(DEFAULT_CONFIG); // the user settings, re-read on every change
let client = null; // the Modbus connection, null while we have none
let state = null; // last readings
let device = null; // { host, serial, model, name }: the identity of the wallbox
let lastRead = 0; // when the readings were taken, to honour the configured interval
let previousCharging = null; // the last charging flank, see chargingEvents()
let connecting = null; // the connect attempt running right now, or null

/** The heartbeat. Its `write` runs on whatever connection is current. */
const control = new AliveControl({
  write: (register, value) => {
    if (!client) throw new Error('Keine Verbindung zur Wallbox');
    return client.writeRegister(register, value);
  },
  log: (message) => logger.warn(message),
});

const NO_HOST = {
  de: 'Bitte die Adresse der Wallbox in der Konfiguration eintragen.',
  en: 'Enter the wallbox address in the configuration.',
  fr: "Indiquez l'adresse de la borne dans la configuration.",
  es: 'Introduce la direcci\u00f3n del cargador en la configuraci\u00f3n.',
};

/** Read the configuration Gladys holds into `config`. */
async function readConfig() {
  config = normalizeConfig(await gladys.getConfig());
  control.configure({
    failsafeCurrent: config.failsafe_current,
    failsafeTimeout: config.failsafe_timeout,
  });
  return config;
}

/**
 * Connect to the wallbox, once at a time.
 *
 * `finally` clears the gate rather than a plain assignment after the await: if the
 * attempt throws, a gate left set would make every later caller wait on a promise
 * that has already settled, and the integration would never connect again.
 */
async function connectDevice() {
  if (connecting) return connecting;

  connecting = establish();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/**
 * Do the actual connect: keep a good connection, otherwise build one.
 *
 * KEEPING A CONNECTION THAT IS STILL GOOD
 * The conditions are deliberately narrow: there must be a live socket, and it must
 * point at the configured host and port. A connection whose peer has gone, or one a
 * failed read has already dropped, is NOT kept — those are the cases where a fresh
 * build is genuinely needed.
 *
 * CLOSING BEFORE OPENING, AND WAITING FOR IT
 * The EVC04 allows exactly ONE Modbus master. Giving the old socket back with
 * `destroy()` returns at once and the device only frees the slot when the FIN
 * arrives, so a new connect landing in that gap is refused. `close()` waits for the
 * socket to report down.
 */
async function establish() {
  const sameTarget = Boolean(
    client && device && device.host === config.host && client.port === config.modbus_port,
  );
  if (client?.transport?.isOpen && sameTarget) {
    state = await client.readAll().catch((err) => {
      logger.warn(`Refresh on the existing connection failed: ${err.message}`);
      return state;
    });
    lastRead = Date.now();
    await gladys.setConnectionStatus(true);
    return true;
  }

  if (client) {
    await client.transport?.close?.().catch(() => {});
    client = null;
  }
  state = null;
  device = null;
  previousCharging = null;
  control.clear();

  if (!config.host) {
    await gladys.setConnectionStatus(false, NO_HOST);
    return false;
  }

  try {
    const connection = new Evc04Client({
      host: config.host,
      port: config.modbus_port,
      unitId: config.unit_id,
    });
    // Tolerated problems are logged, never thrown.
    connection.warn = (what, err) => logger.warn(`Tolerated (${what}): ${err.message}`);
    // The Modbus layer uses this separate hook for successful raw meter reads.
    // Keeping it at info level makes the temporary diagnostic visible without
    // incorrectly classifying a valid register response as a warning.
    connection.diagnostic = (message) => logger.info(message);
    const info = await connection.connect();

    device = {
      host: config.host,
      serial: info.serial,
      model: info.model,
      firmware: info.firmware,
      name: 'Wallbox',
    };
    client = connection;

    const limits = await client.readLimits().catch(() => null);
    device.limits = limits;
    state = await client.readAll();
    lastRead = Date.now();
    logger.info(
      `Wallbox ready: ${device.serial || 'no serial'}, firmware ${info.firmware || 'unknown'}, ` +
        `${Object.keys(state).length} readings, charging current range ` +
        `${limits ? `${limits.min}-${limits.max}` : 'not reported'} A, ` +
        `charging ${state.charging_current ?? '?'} (register 1500)`,
    );
    await gladys.setConnectionStatus(true);
    return true;
  } catch (err) {
    // A failed attempt must not leave a half-open socket behind: this device allows
    // one master, and a stranded socket would block the next attempt.
    client?.transport?.reset();
    client = null;
    logger.error(`Wallbox connection failed (${config.host}): ${err.message}`);
    await gladys
      .setConnectionStatus(false, {
        de: `Wallbox nicht erreichbar: ${err.message}`.slice(0, 200),
        en: `Wallbox not reachable: ${err.message}`.slice(0, 200),
        fr: `Borne injoignable : ${err.message}`.slice(0, 200),
        es: `Cargador no accesible: ${err.message}`.slice(0, 200),
      })
      .catch(() => {});
    return false;
  }
}

/**
 * Run `task` on the one connection this process owns, and return its answer.
 *
 * WHY THE RETRY EXISTS
 * When the container is recreated, the device-side socket can survive until its own
 * timeout, and the first attempt then meets a slot that is still occupied. One
 * deliberate retry on a fresh connection rides that out.
 *
 * WHY THE ORIGINAL ERROR IS CARRIED ALONG
 * When the retry fails as well, the error thrown here would otherwise say only "no
 * connection" — the symptom, not the cause. The first error is attached as `cause`,
 * so a reader of the log sees what was tried and why it broke.
 */
async function withConnection(task) {
  if (!client) {
    if (!(await connectDevice())) throw new Error('Keine Verbindung zur Wallbox');
  }
  try {
    return await task(client);
  } catch (err) {
    logger.warn(`Read failed (${err.message}) -> one retry on a fresh connection`);
    client?.transport?.reset();
    client = null;
    if (!(await connectDevice())) {
      throw new Error('Keine Verbindung zur Wallbox nach einem zweiten Versuch', { cause: err });
    }
    return await task(client);
  }
}

/**
 * Publish the device, so it appears in the Discovery tab where the user creates
 * it. Publishing is an offer, not a creation: Gladys keeps the user in control.
 *
 * `onScanRequest` has the signature `() => void | Promise<void>`: the callback
 * answers by CALLING this, and anything it returns is read by nobody. An earlier
 * version returned the device as the callback's value — the call was accepted, the
 * value dropped, and the Discovery screen stayed empty.
 */
async function publishDevice() {
  if (!device || !state) return;
  // Gladys accepts scheduler frequencies only up to 60 seconds. Its one-minute
  // ticks are used as a clock; refresh() skips ticks until the configured interval.
  const payload = buildDevice(gladys, device, state, 60000, device.limits);
  logger.info(`publishDiscoveredDevices -> "${payload.name}" with ${payload.features.length} features`);
  for (const feature of payload.features) {
    logger.info(`  feature: ${feature.name} | ${feature.category}/${feature.type} | ${feature.unit}`);
  }
  await gladys.publishDiscoveredDevices([payload]);
  await publishAll(gladys, device, state);
}

/**
 * Read the wallbox again, publish the value, and fire the charging flanks.
 *
 * THE ORDER MATTERS: the events are worked out from the reading BEFORE the reading
 * is published, so a scene that reacts to "charging started" reads the figures of
 * the session that just started rather than the one before it.
 */
async function refresh() {
  if (!client) return;
  state = await client.readAll();
  lastRead = Date.now();

  const { events, side } = chargingEvents({ snapshot: state, previous: previousCharging });
  previousCharging = side;
  for (const event of events) {
    await gladys
      .publishSceneEvent(event.key, event.data)
      .catch((err) => logger.error('publishSceneEvent failed', err.message));
  }

  await publishAll(gladys, device, state);
}

/** The external id of one feature of this device, or null before the first read. */
function featureId(key) {
  if (!device) return null;
  return gladys.externalIds(PLATFORM_TYPE, platformId(device)).feature(key);
}

// --- Discovery ---------------------------------------------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> called by Gladys');
  if (!client && !(await connectDevice())) {
    logger.warn('onScanRequest -> no wallbox, nothing published');
    return;
  }
  await publishDevice();
});

// --- Polling -----------------------------------------------------------------
// Gladys ticks a polled device once a minute at most; the interval the user chose
// is applied by skipping ticks, so `poll_frequency` is honoured instead of being
// overwritten by the scheduler's pace.
gladys.onPoll(async (polled) => {
  if (!client || !device) return;
  if (polled?.external_id !== deviceExternalId(gladys, device)) return;
  if (Date.now() - lastRead < config.poll_frequency - 60000) return;
  await refresh().catch((err) => logger.warn(`Poll failed: ${err.message}`));
  gladys.requestWidgetRefresh(CHARGER_WIDGET);
});

// --- Setpoint ----------------------------------------------------------------
// A command from Gladys: the value of the one writable feature changed. The value
// is written to register 5004, the heartbeat is told to keep it in force, and the
// device is read once so the card shows what the wallbox reports.
gladys.onSetValue(async (dev, feature, value) => {
  const wanted = Number(value);
  if (!Number.isFinite(wanted)) throw new Error('Der Ladestrom muss eine Zahl sein');

  await withConnection(async (connection) => {
    const limits = connection.getLimits();
    const current = Math.min(limits.max, Math.max(limits.min, Math.round(wanted)));
    await connection.writeRegister(CONTROL.charging_current, current);
    control.set(current);
    logger.info(`Setpoint ${current} A written to register 5004`);
  });
  await refresh().catch(() => {});
  gladys.requestWidgetRefresh(CHARGER_WIDGET);
});

// --- Widget ------------------------------------------------------------------
// WITHOUT THESE TWO HANDLERS THE CARD SAYS "not implemented".
gladys.onWidgetGet(CHARGER_WIDGET, async (settings = {}) => {
  // Pick up a fresh reading, so the tile is not a minute stale when it is opened.
  if (client && Date.now() - lastRead > 10000) await refresh().catch(() => {});
  return buildChargerContent({
    state,
    device,
    ids: {
      total_current:
        Number.isFinite(Evc04Client.reading(state, TOTAL_CURRENT_READING))
          ? featureId(TOTAL_CURRENT_READING)
          : null,
      cable_state:
        Evc04Client.stateWord(state, 'cable_state') !== null
          ? featureId('cable_state')
          : null,
    },
    controlled: control.active ? control.current : null,
    settings,
    t,
    sentence: (snapshot) =>
      deviceSentence({
        word: Evc04Client.stateWord(snapshot, 'chargepoint_state'),
        power: Evc04Client.reading(snapshot, 'power'),
        faultCode: Evc04Client.reading(snapshot, 'fault_code'),
      }),
  });
});

/**
 * A tap on + or − on the card.
 *
 * The card worked out the intention; this applies it. That split is what keeps the
 * widget from being able to write to a device on its own, and it is the shape the
 * WattWächter uses for its period buttons. The intention is clamped against the
 * limits the DEVICE reported, not against a constant.
 */
gladys.onWidgetAction(CHARGER_WIDGET, async (actionKey, params) => {
  const intent = chargerAction({
    actionKey,
    params,
    state,
    limits: client?.getLimits(),
    t,
  });
  await withConnection(async (connection) => {
    await connection.writeRegister(CONTROL.charging_current, intent.current);
  });
  control.set(intent.current);
  await refresh().catch(() => {});
  gladys.requestWidgetRefresh(CHARGER_WIDGET);
  return intent.toast;
});

/** The one scene action: set the charging current, with the heartbeat kept alive. */
gladys.onSceneAction('set_charging_current', async (fields) => {
  return SCENE_ACTIONS.set_charging_current({
    client,
    fields,
    control,
    connect: connectDevice,
  });
});

/**
 * Manifest action "Test the connection": the button in the Configuration screen.
 *
 * It answers in words rather than only in the log. It reads over the connection this
 * process already owns: a client of its own would be a second master, which this
 * device does not allow.
 */
gladys.onAction('test_connection', async () => {
  await readConfig().catch(() => {});
  try {
    const readings = await withConnection((connection) => connection.readAll());
    const current = readings.charging_current;
    return {
      de: `Antwort: ${device?.model || 'Wallbox'}, Firmware ${device?.firmware || 'unbekannt'}. ${Object.keys(readings).length} Messwerte, Ladestrom ${current ?? '?'} (Zehntelampere).`,
      en: `Answered: ${device?.model || 'Wallbox'}, firmware ${device?.firmware || 'unknown'}. ${Object.keys(readings).length} readings, charging current ${current ?? '?'} (tenths of an ampere).`,
      fr: `R\u00e9ponse : ${device?.model || 'Wallbox'}, firmware ${device?.firmware || 'inconnu'}. ${Object.keys(readings).length} mesures, courant ${current ?? '?'} (dixi\u00e8mes d'amp\u00e8re).`,
      es: `Respuesta: ${device?.model || 'Wallbox'}, firmware ${device?.firmware || 'desconocido'}. ${Object.keys(readings).length} medidas, corriente ${current ?? '?'} (d\u00e9cimas de amperio).`,
    };
  } catch (err) {
    logger.error(`Connection test failed (${config.host}): ${err.message}`);
    return {
      de: `Keine verwertbare Antwort von ${config.host}: ${err.message}. Ist Modbus TCP in der Wallbox eingeschaltet?`,
      en: `No usable answer from ${config.host}: ${err.message}. Is Modbus TCP switched on in the wallbox?`,
      fr: `Aucune r\u00e9ponse exploitable de ${config.host} : ${err.message}. Le Modbus TCP est-il activ\u00e9 dans la borne ?`,
      es: `Sin respuesta utilizable de ${config.host}: ${err.message}. \u00bfEst\u00e1 activado el Modbus TCP en el cargador?`,
    };
  }
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    await readConfig();
    if (await connectDevice()) await publishDevice();
    gladys.requestWidgetRefresh(CHARGER_WIDGET);
  } catch (err) {
    logger.error('Post-connection initialization failed', err.message);
  }
});

gladys.onConfigUpdated(async (newConfig) => {
  config = normalizeConfig(newConfig);
  control.configure({
    failsafeCurrent: config.failsafe_current,
    failsafeTimeout: config.failsafe_timeout,
  });
  previousCharging = null;
  if (await connectDevice()) await publishDevice();
  gladys.requestWidgetRefresh(CHARGER_WIDGET);
});

// --- Shutdown ----------------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  control.clear();
  control.stop();
  await client?.transport?.close().catch(() => {});
  client = null;
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Vestel EVC04 integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err.message);
});
