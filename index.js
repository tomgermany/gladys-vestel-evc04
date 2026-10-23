// -----------------------------------------------------------------------------
// Entry point (the "wiring"): it connects the pieces, it holds no logic.
//
// WHAT THIS FILE DOES
// It creates the SDK connection to Gladys, registers the handlers Gladys calls
// (scan, poll, action, scenes, widget) and starts the container. Everything else
// lives in src/:
//   src/vestel/transport.js  the raw TCP socket
//   src/vestel/modbus.js     the Modbus protocol
//   src/vestel/registers.js  the register map, the read/write rule, and KEY
//   src/vestel/client.js     registers as named readings
//   src/devices/wallbox.js   the wallbox as a Gladys device
//   src/widgets.js           the dashboard card
//   src/scenes.js            the triggers and the actions
//   src/alive.js             the heartbeat for register 6000
//   src/labels.js            the runtime texts
//   src/config.js            defaults and normalisation
//
// THE ONE ORDERING RULE
// Every handler is registered BEFORE `gladys.connect()`. Gladys may send a message
// the moment the connection opens, and a handler registered later would simply
// miss it.
//
// WHERE KEY COMES FROM, AND WHY THAT IS WORTH A SENTENCE
// The feature keys live in src/vestel/registers.js, next to the register map they
// describe. An earlier version of this file imported them from src/labels.js,
// where they never existed: `npm run lint` does not check whether a named export
// really exists in the module it is imported from, so the CI stayed green and the
// container died on its first start with
//   SyntaxError: does not provide an export named 'KEY'
// A lint pass is not a load test. This file is the only place that would have
// caught it, and only by running.
//
// ONE CONNECTION, AND THE HEARTBEAT RUNS ON IT
// The EVC04 allows exactly ONE Modbus master at a time, so this process owns the
// only connection and every read — poll, scan, connection test — runs on it. The
// alive heartbeat writes through the same client, which is the point: a second
// socket would be refused by the device, and a second socket that carried the
// heartbeat would be the one that got refused at exactly the wrong moment.
//
// WHY THE HEARTBEAT STARTS WITH A CURRENT AND STOPS WHEN RELEASED
// A beat that runs all the time would hold the wallbox under external control even
// when nothing is being controlled. See src/alive.js for what that costs.
//
// SDK: @gladysassistant/integration-sdk ^0.15 (Gladys >= 5.1.0).
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';

import { normalizeConfig } from './src/config.js';
import { Evc04Client } from './src/vestel/client.js';
import { KEY } from './src/vestel/registers.js';
import {
  buildDevice,
  decorate,
  deviceExternalId,
  platformId,
  publishAll,
  PLATFORM_TYPE,
} from './src/devices/wallbox.js';
import { SCENE_ACTIONS, chargingEvents } from './src/scenes.js';
import { CHARGER_WIDGET, buildChargerContent, chargerAction } from './src/widgets.js';
import { AliveControl } from './src/alive.js';
import { stateSentence, t } from './src/labels.js';

const gladys = new GladysIntegration();

// --- State of the running integration ----------------------------------------
let config = normalizeConfig(); // the user settings, re-read on every change
let client = null; // the Modbus connection, null while we have none
let snapshot = null; // the last readings
let device = null; // { host, serial, model, name }
let lastRead = 0; // when the readings were taken, to honour poll_frequency
let lastCharging = null; // null until the first reading, see src/scenes.js
let connecting = null; // the connect attempt running right now, or null
let flank = false; // did the last read change the charging state?

// The heartbeat. It writes through `client`, which means it also works while a
// scene is running: the wallbox sees one master answering, whoever asked for the
// current.
const control = new AliveControl({
  write: (register, value) => client.writeRegister(register, value),
  log: (message) => logger.warn(message),
});

const NO_HOST = {
  de: 'Bitte die Adresse der Wallbox in der Konfiguration eintragen.',
  en: 'Enter the wallbox address in the configuration.',
  fr: "Indiquez l'adresse de la borne dans la configuration.",
  es: 'Introduce la dirección del cargador en la configuración.',
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
 * THE GATE, AND WHY IT IS HERE AND NOT IN `establish()`
 * `connected` and `onConfigUpdated` both connect, and on a restart both fire within
 * seconds of each other. A second caller must not start a competing connection —
 * the device allows one master, so a second attempt would not fail cleanly, it
 * would take the slot from the first. `finally` clears the gate rather than a plain
 * assignment: a gate left set after a throw would make every later caller wait on a
 * promise that has already settled, and the integration would never connect again.
 */
async function connectWallbox() {
  if (connecting) return connecting;
  connecting = establish();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Do the actual connect: hand the old connection back, open a new one, read once. */
async function establish() {
  if (client) {
    await client.transport?.close?.().catch(() => {});
    client = null;
  }
  snapshot = null;
  device = null;
  lastCharging = null;
  flank = false;

  if (!config.host) {
    await gladys.setConnectionStatus(false, NO_HOST);
    return false;
  }

  try {
    const next = new Evc04Client({
      host: config.host,
      port: config.modbus_port,
      unitId: config.unit_id,
    });
    next.warn = (what, err) => logger.warn(`Tolerated (${what}): ${err.message}`);
    const info = await next.connect();

    client = next;
    device = {
      host: config.host,
      serial: info.serial,
      model: info.model || info.brand || 'Wallbox',
      name: info.chargepointId || info.serial || 'Wallbox',
    };

    // The limits are read once, here: they are the device's own figures and they
    // change when somebody changes them on the device, not on every poll.
    const limits = await client.readLimits().catch(() => null);
    snapshot = decorate(await client.readAll());
    logger.info(
      `Wallbox ready: ${device.model} (${device.serial}), firmware ${info.firmware}, ` +
        `${Object.keys(snapshot).length} readings, state ${snapshot.chargepoint_state}, ` +
        `charging current ${limits ? `${limits.min}-${limits.max} A` : 'unknown'}`,
    );
    await gladys.setConnectionStatus(true);
    return true;
  } catch (err) {
    // A failed attempt must not leave a half-open socket behind: the device allows
    // one master, and a stranded socket would keep the next attempt from taking it.
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
 * Publish the wallbox, so it appears in the Discovery tab where the user creates
 * it. Publishing is an offer, not a creation: Gladys keeps the user in control.
 */
async function publishDevice() {
  if (!device || !snapshot) return;
  const payload = buildDevice(gladys, device, snapshot);
  logger.info(
    `publishDiscoveredDevices -> "${payload.name}" with ${payload.features.length} features`,
  );
  await gladys.publishDiscoveredDevices([payload]);
  await publishAll(gladys, device, snapshot);
}

/** Read the wallbox again, publish every value, and check the charging flank. */
async function refresh() {
  if (!client) return;
  snapshot = decorate(await client.readAll());
  lastRead = Date.now();
  await publishAll(gladys, device, snapshot);
  await fireChargingEvents();
  // A card showing a charge is worth redrawing when the charge changes: the
  // sentence on it says something else the moment energy starts or stops flowing,
  // and waiting for the next dashboard refresh would show the old one.
  if (flank) gladys.requestWidgetRefresh(CHARGER_WIDGET);
}

/**
 * The two scene triggers: "started" and "finished".
 *
 * The comparison lives in src/scenes.js, next to the comment that explains why a
 * trigger cannot carry a threshold. Here is only the part that needs the running
 * process: remembering the last state, publishing what came back, and telling the
 * card that its sentence has changed.
 */
async function fireChargingEvents() {
  const { events, side } = chargingEvents({ snapshot, previous: lastCharging });
  flank = side !== lastCharging;
  lastCharging = side;
  for (const event of events) {
    await gladys
      .publishSceneEvent(event.key, event.data)
      .catch((err) => logger.error(`publishSceneEvent ${event.key} failed`, err.message));
  }
}

// --- Discovery ---------------------------------------------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> called by Gladys');
  if (!client && !(await connectWallbox())) {
    logger.warn('onScanRequest -> no wallbox, nothing published');
    return;
  }
  await publishDevice();
});

// --- Polling -----------------------------------------------------------------
// Gladys ticks a polled device once a minute at most; the interval the user chose
// is applied by skipping ticks, so a 60-second setting simply ignores every other
// tick.
gladys.onPoll(async (polled) => {
  if (!client || !device) return;
  if (polled.external_id !== deviceExternalId(gladys, device)) return;
  if (Date.now() - lastRead < config.poll_frequency - 15000) return;
  await refresh().catch((err) => logger.warn(`Poll failed: ${err.message}`));
});

/**
 * Manifest action "Test the connection".
 *
 * It answers in words, and it names the two things that cannot be guessed: the
 * address base, and the current range the device reports. If the serial number
 * comes back as noise, the register map is being read with the wrong
 * interpretation, and the user should hear that here rather than wonder why every
 * value looks wrong.
 */
gladys.onAction('test_connection', async () => {
  await readConfig().catch(() => {});
  if (!client && !(await connectWallbox())) {
    return {
      de: `Keine Antwort von ${config.host}. Ist Modbus TCP in der Wallbox eingeschaltet?`,
      en: `No answer from ${config.host}. Is Modbus TCP switched on in the wallbox?`,
      fr: `Aucune réponse de ${config.host}. Le Modbus TCP est-il activé dans la borne ?`,
      es: `Sin respuesta de ${config.host}. ¿Está activado Modbus TCP en el cargador?`,
    };
  }
  try {
    const info = await client.connect();
    const limits = await client.readLimits().catch(() => null);
    const readings = decorate(await client.readAll());
    snapshot = readings;
    const looksLikeText = /^[\x20-\x7e]*$/.test(info.serial ?? '');
    const hint = looksLikeText
      ? ''
      : ' Die Seriennummer ist kein lesbarer Text — vermutlich stimmt ADDRESS_BASE in src/vestel/registers.js nicht.';
    const range = limits ? `${limits.min}-${limits.max} A` : 'unbekannt';
    return {
      de:
        `Antwort: ${info.brand ?? '?'} ${info.model ?? '?'}, Seriennummer ${info.serial ?? '?'}, ` +
        `Firmware ${info.firmware ?? '?'}. Zustand ${readings.chargepoint_state ?? '?'}, ` +
        `${Object.keys(readings).length} Werte, Ladestrom-Bereich ${range}.${hint}`,
      en:
        `Answered: ${info.brand ?? '?'} ${info.model ?? '?'}, serial ${info.serial ?? '?'}, ` +
        `firmware ${info.firmware ?? '?'}. State ${readings.chargepoint_state ?? '?'}, ` +
        `${Object.keys(readings).length} readings, charging current range ${range}.` +
        (looksLikeText
          ? ''
          : ' The serial number is not readable text — ADDRESS_BASE in src/vestel/registers.js is probably wrong.'),
      fr:
        `Réponse : ${info.brand ?? '?'} ${info.model ?? '?'}, série ${info.serial ?? '?'}, ` +
        `firmware ${info.firmware ?? '?'}. État ${readings.chargepoint_state ?? '?'}, ` +
        `${Object.keys(readings).length} valeurs, plage de courant ${range}.` +
        (looksLikeText
          ? ''
          : ' Le numéro de série n’est pas du texte lisible — ADDRESS_BASE dans src/vestel/registers.js est probablement faux.'),
      es:
        `Respuesta: ${info.brand ?? '?'} ${info.model ?? '?'}, serie ${info.serial ?? '?'}, ` +
        `firmware ${info.firmware ?? '?'}. Estado ${readings.chargepoint_state ?? '?'}, ` +
        `${Object.keys(readings).length} valores, rango de corriente ${range}.` +
        (looksLikeText
          ? ''
          : ' El número de serie no es texto legible: probablemente ADDRESS_BASE en src/vestel/registers.js es incorrecto.'),
    };
  } catch (err) {
    logger.error(`Connection test failed (${config.host}): ${err.message}`);
    return {
      de: `Keine brauchbare Antwort von ${config.host}: ${err.message}`,
      en: `No usable answer from ${config.host}: ${err.message}`,
      fr: `Aucune réponse exploitable de ${config.host} : ${err.message}`,
      es: `Sin respuesta aprovechable de ${config.host}: ${err.message}`,
    };
  }
});

// --- Commands ----------------------------------------------------------------
// The user moved a control on the device page. Do the work on the wallbox, then
// confirm the value back so the interface shows what really happened. Throwing
// fails the command visibly, which is what a refused write should do.
gladys.onSetValue(async (_device, feature, value) => {
  if (!client) throw new Error('Wallbox nicht verbunden');
  const ids = gladys.externalIds(PLATFORM_TYPE, platformId(device));
  if (feature.external_id !== ids.feature(KEY.CHARGING_CURRENT)) {
    throw new Error(`Nicht schreibbar: ${feature.external_id}`);
  }
  const current = Math.round(Number(value));
  if (!Number.isFinite(current)) throw new Error('Ladestrom muss eine Zahl sein');
  // The same path a scene and a button take, so the clamp against the device's
  // own limits cannot be forgotten here.
  const applied = await SCENE_ACTIONS.set_charging_current({
    client,
    fields: { current },
    control,
  });
  await gladys.publishState(feature.external_id, applied.current);
  gladys.requestWidgetRefresh(CHARGER_WIDGET);
  return applied.current;
});

// --- Scene actions -----------------------------------------------------------
for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
  gladys.onSceneAction(key, (fields) => handler({ client, fields, control }));
}

// --- Dashboard widget --------------------------------------------------------
gladys.onWidgetGet(CHARGER_WIDGET, async () => {
  // Read the wallbox first, so the card shows the truth, but keep the last known
  // state if that read fails: a stale sentence beats an empty card.
  if (client) snapshot = decorate(await client.readAll().catch(() => snapshot));
  const ids = device ? gladys.externalIds(PLATFORM_TYPE, platformId(device)) : null;
  return buildChargerContent({
    state: snapshot,
    device,
    ids: {
      power: ids?.feature(KEY.POWER) ?? null,
      session_energy: ids?.feature(KEY.SESSION_ENERGY) ?? null,
      meter_reading: ids?.feature(KEY.METER_READING) ?? null,
      charging_current: ids?.feature(KEY.CHARGING_CURRENT) ?? null,
    },
    // The NUMBER the tile is labelled with, or null when nothing is under our
    // control and the wallbox is using its own setting.
    controlled: control.current,
    t,
    sentence: (state) => stateSentence(state),
  });
});

gladys.onWidgetAction(CHARGER_WIDGET, async (actionKey, params) => {
  const intent = chargerAction({
    actionKey,
    params,
    state: snapshot,
    controlled: control.current,
    limits: client?.getLimits(),
    t,
  });
  // The card decides what a tap means; this is where it happens. Setting and
  // releasing both go through the scene actions, so a button and a scene do
  // exactly the same thing to the wallbox.
  if (intent.release) {
    await SCENE_ACTIONS.release_charging_current({ client, control });
  } else {
    await SCENE_ACTIONS.set_charging_current({
      client,
      fields: { current: intent.current },
      control,
    });
  }
  gladys.requestWidgetRefresh(CHARGER_WIDGET);
  return intent.toast;
});

// --- Configuration -----------------------------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  config = normalizeConfig(newConfig);
  control.configure({
    failsafeCurrent: config.failsafe_current,
    failsafeTimeout: config.failsafe_timeout,
  });
  lastCharging = null;
  flank = false;
  if (await connectWallbox()) await publishDevice();
  gladys.requestWidgetRefresh(CHARGER_WIDGET);
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    await readConfig();
    if (await connectWallbox()) await publishDevice();
    gladys.requestWidgetRefresh(CHARGER_WIDGET);
  } catch (err) {
    logger.error('Post-connection initialization failed', err.message);
  }
});

// --- Shutdown ----------------------------------------------------------------
// The container is stopped on every restart and update. The heartbeat stops FIRST:
// a beat that outlives the shutdown would keep the wallbox under external control
// while nothing is there to release it, and the failsafe value could never take
// over.
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  control.stop();
  await client?.transport?.close?.().catch(() => {});
  client = null;
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Vestel EVC04 integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err.message);
  process.exit(1);
});
