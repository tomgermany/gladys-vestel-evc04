// -----------------------------------------------------------------------------
// The wallbox as a Gladys device: which features exist, and how they are built.
//
// WHAT A FEATURE IS IN GLADYS
// A feature is one value of a device: the power, one phase current, the meter
// reading. It carries a name, an external id, a category, a type and a unit.
// Gladys files and displays it by its category, which is why the category has to
// be one Gladys knows: an unknown category is not a warning, it is a refusal of
// the WHOLE device.
//
// TWO KINDS OF FEATURE, AND WHY THEY ARE NOT INTERCHANGEABLE
// A READING (energy-sensor, type power/voltage/current/index) is published as a
// bare NUMBER. A STATE is not: Gladys validates its value and answers
//   states[0]: must have a numeric "state" or a string "text"
// when it gets anything else. What that message means, read from the core
// (server/lib/external-integration/externalIntegration.saveStates.js):
//
//   const hasNumericState = typeof state.state === 'number' && Number.isFinite(state.state);
//   const hasText = typeof state.text === 'string';
//   if (!hasNumericState && !hasText) throw new BadParameters(...)
//
// So a state value must be an OBJECT — { state: 2 } or { text: '...' } — and the
// SDK types it exactly that way in DeviceState. That is the mistake this file made
// twice: first a bare string, then a bare number. Both were refused, and a refused
// state leaves the device half-populated on every poll — the log showed 8 features
// instead of 14.
//
// WHICH SHAPE THIS FILE USES FOR A STATE
// TEXT, because the sentence a user reads is already built in src/labels.js, and a
// text feature is the one that stores strings — server/utils/device.js:
//
//   isStringStateFeature: category TEXT with type TEXT or SELECT
//
// The NUMBER stays alongside as its own reading, so a scene can compare on it. The
// word is the card's business; the number is the machine's.
//
// WHICH FEATURES EXIST IS DECIDED BY THE DEVICE
// The builder only makes a feature for a key the wallbox really answered. A
// three-phase charge point that reports no current on L3 gets no L3 feature, and
// the interface never shows a zero that would be wrong.
//
// UNITS ARE CONVERTED ONCE, HERE
// The device reports current in milliamperes and the meter reading in tenths of a
// kilowatt-hour. Gladys stores amperes and kilowatt-hours, so both divisions happen
// on the way in — in this file, so a scene and the interface cannot disagree about
// the unit of the same number.
//
// ONLY ONE FEATURE IS WRITABLE, AND IT SAYS SO
// `charging_current` is the single feature a user can set from Gladys. Everything
// else — the limits, the states, the meter — is a reading. The device has no start
// and no stop command, so there is nothing else TO write.
//
// THE DEVICE IS POLLED, AND THE RATE IS DECLARED HERE
// `should_poll: true` alone is not enough: the SDK states that Gladys schedules a
// device only with BOTH `should_poll` and a `poll_frequency`, the latter in
// MILLISECONDS and chosen from DEVICE_POLL_FREQUENCIES (1 s, 2 s, 10 s, 15 s,
// 30 s, 1 min) — any other value is refused with a 400. Without it the device is
// read once on connect and never again, which looks exactly like a broken
// integration. The rate comes from the configuration, so the user's choice is what
// Gladys is told.
//
// IT IS UNIT-TESTED WITHOUT A DEVICE: buildDevice() takes a plain snapshot, so the
// tests hand it hand-written readings.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
  createLogger,
} from '@gladysassistant/integration-sdk';
import { DEFAULT_MIN_CURRENT, DEFAULT_MAX_CURRENT } from '../vestel/registers.js';
import { deviceSentence, cableSentence } from '../labels.js';

const logger = createLogger({ name: 'wallbox' });

const POWER = TYPE.ENERGY?.POWER ?? 'power';
const ENERGY = TYPE.ENERGY?.INDEX ?? 'index';
const CURRENT = TYPE.ENERGY?.CURRENT ?? 'current';
const TEXT = TYPE.TEXT?.TEXT ?? 'text';

/**
 * The category of every energy reading here.
 *
 * `energy-sensor` is the category that carries a three-phase meter: power, energy,
 * voltage, current, index. It is the only energy category in this file on purpose —
 * a second one would have to be a category Gladys knows, and the whole device is
 * refused if it is not.
 */
const CAT_ENERGY = CAT.ENERGY_SENSOR;

/**
 * One row per feature.
 *
 *   key     : the reading it carries, and the suffix of its external id. Never
 *             rename it: Gladys keys the history, the scenes and the dashboards on
 *             these ids.
 *   scale   : applied on the way in; keep it in step with `unit` or the numbers lie.
 *   writable: true when the user can set it from Gladys.
 *   asText  : published as { text: ... } instead of { state: ... }, for the two
 *             states. See the note at the top of this file.
 */
export const FEATURES = [
  // --- What the wallbox is doing, as the sentence a user reads ---
  {
    key: 'charge_state',
    name: 'Ladezustand',
    category: CAT.TEXT,
    type: TEXT,
    asText: true,
    keep_history: false,
    writable: false,
  },
  {
    key: 'cable_state',
    name: 'Kabelzustand',
    category: CAT.TEXT,
    type: TEXT,
    asText: true,
    keep_history: false,
    writable: false,
  },

  // --- The same two states as numbers, for a scene to compare on ---
  // A text feature cannot be compared with a threshold, so the code stays available
  // as its own reading. It carries no unit: a code is not a quantity.
  {
    key: 'chargepoint_state',
    name: 'Ladezustand (Code)',
    category: CAT_ENERGY,
    type: POWER,
    scale: 1,
    keep_history: false,
    writable: false,
  },
  {
    key: 'cable_code',
    name: 'Kabelzustand (Code)',
    category: CAT_ENERGY,
    type: POWER,
    scale: 1,
    keep_history: false,
    writable: false,
  },
  {
    key: 'charging',
    name: 'Lädt',
    category: CAT.SWITCH,
    type: TYPE.SWITCH.BINARY,
    min: 0,
    max: 1,
    scale: 1,
    writable: false,
  },

  // --- The live reading ---
  {
    key: 'power',
    name: 'Ladeleistung',
    category: CAT_ENERGY,
    type: POWER,
    unit: UNIT.WATT,
    scale: 1,
    writable: false,
  },
  {
    key: 'current_l1',
    name: 'Ladestrom L1',
    category: CAT_ENERGY,
    type: CURRENT,
    unit: UNIT.AMPERE,
    // The device reports milliamperes.
    scale: 1 / 1000,
    writable: false,
  },

  // --- What has been charged ---
  {
    key: 'meter_reading',
    name: 'Zählerstand',
    category: CAT_ENERGY,
    type: ENERGY,
    unit: UNIT.KILOWATT_HOUR,
    // The device counts in 0.1 kWh steps.
    scale: 1 / 10,
    writable: false,
  },
  {
    key: 'session_energy',
    name: 'Energie dieser Ladung',
    category: CAT_ENERGY,
    type: ENERGY,
    unit: UNIT.KILOWATT_HOUR,
    // The device reports watt-hours.
    scale: 1 / 1000,
    writable: false,
  },

  // --- The limits the DEVICE reports, shown so the user can see them ---
  // Read-only on purpose. These are the installer's figures, and showing them is
  // how a user can tell why a setpoint of 16 A turned into 13: the wallbox says 13
  // is its maximum. Nothing in Gladys can change them.
  { key: 'evse_max_current', name: 'Maximaler Ladestrom (Wallbox)', category: CAT_ENERGY, type: CURRENT, unit: UNIT.AMPERE, scale: 1, writable: false },
  { key: 'cable_max_current', name: 'Maximaler Ladestrom (Kabel)', category: CAT_ENERGY, type: CURRENT, unit: UNIT.AMPERE, scale: 1, writable: false },

  // --- The control ---
  // The charging current is the only thing this integration sets, because it is the
  // only thing the device can be told. It overrides what the wallbox would do on
  // its own, and the heartbeat in src/alive.js is what keeps it in force.
  //
  // The min and max here are only what a slider offers before the device has
  // answered; every write is clamped against the limits the WALLBOX reported, with
  // the floor the app prescribes. Keeping them to the fallbacks in registers.js
  // means the two cannot drift apart.
  {
    key: 'charging_current',
    name: 'Ladestrom',
    category: CAT_ENERGY,
    type: CURRENT,
    unit: UNIT.AMPERE,
    scale: 1,
    min: DEFAULT_MIN_CURRENT,
    max: DEFAULT_MAX_CURRENT,
    writable: true,
  },
];

/**
 * The platform id of ONE wallbox, and why it is not the name.
 *
 * Gladys keys history, scenes and dashboards on the external id, so it has to
 * survive a rename and stay unique when two charge points share an installation.
 * The serial is what the hardware reports; the host is only a fallback for a device
 * that answers nothing there.
 */
export const platformId = (device) => device.serial || device.host;

/**
 * The type segment of the external ids, deliberately empty.
 *
 * The SDK composes `ext:<selector>:<type>:<platformId>`, and Gladys checks that the
 * id starts with `ext:<selector>:`. The selector is the integration's own name, set
 * by the supervisor, and it is already in the id. Putting anything here would push
 * the platform id one segment to the right and Gladys would refuse the whole
 * device.
 */
export const PLATFORM_TYPE = '';

/** The device external id, built by the SDK and never by hand. */
export function deviceExternalId(gladys, device) {
  return gladys.externalIds(PLATFORM_TYPE, platformId(device)).device;
}

/** The value to publish for one feature, or null when the reading is missing. */
export function featureValue(feature, snapshot) {
  const raw = snapshot[feature.key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (feature.scale === 1) return raw;
  return Math.round(raw * feature.scale * 10000) / 10000;
}

/**
 * A reading snapshot as the scene actions and the widget receive it.
 *
 * The snapshot holds the device's own names and units. What this adds is the one
 * thing every consumer wants: a flag that says whether energy is flowing right now,
 * which is also the value the two scene triggers watch.
 *
 * `cable_code` is copied from `cable_state` under the name the NUMBER feature uses,
 * so a snapshot read from the device still carries both shapes without the reader
 * having to know about the doubling.
 */
export function decorate(snapshot = {}) {
  if (!snapshot || Object.keys(snapshot).length === 0) return snapshot;
  return {
    ...snapshot,
    charging: snapshot.charging_state === 1 ? 1 : 0,
    cable_code: snapshot.cable_state ?? null,
  };
}

/**
 * The value of the text features, which is the sentence and not the code.
 *
 * Kept apart from featureValue() because it takes the WHOLE snapshot: a state
 * sentence is built from the state and, for a fault, the fault code beside it. An
 * unknown or missing state answers null, and the feature is then left out — an
 * empty box in the interface is worse than a missing one.
 */
export function featureText(feature, snapshot) {
  if (feature.key === 'charge_state') {
    const code = snapshot?.chargepoint_state;
    if (code === null || code === undefined) return null;
    return deviceSentence(snapshot);
  }
  if (feature.key === 'cable_state') {
    const code = snapshot?.cable_state;
    if (code === null || code === undefined) return null;
    return cableSentence(snapshot);
  }
  return null;
}

/**
 * Build the discovery payload: "here is a wallbox, with these readings".
 *
 * Gladys creates nothing from this. It is an offer shown in the Discovery tab, where
 * the user clicks to create the device.
 *
 * `pollFrequency` is the rate the user chose, in milliseconds, and one of the values
 * Gladys accepts. It is passed in rather than fixed here, so the configuration screen
 * is what decides how often the wallbox is read.
 */
export function buildDevice(gladys, device, snapshot, pollFrequency) {
  const ids = gladys.externalIds(PLATFORM_TYPE, platformId(device));
  const features = [];

  for (const f of FEATURES) {
    const present = f.asText ? featureText(f, snapshot) !== null : featureValue(f, snapshot) !== null;
    if (!present) continue;
    features.push({
      name: f.name,
      external_id: ids.feature(f.key),
      category: f.category,
      type: f.type,
      unit: f.unit ?? null,
      min: f.min ?? 0,
      max: f.max ?? 0,
      read_only: !f.writable,
      has_feedback: true,
      keep_history: f.keep_history !== false,
    });
  }

  return {
    name: device.name || 'Wallbox',
    external_id: ids.device,
    model: device.model,
    should_poll: true,
    poll_frequency: pollFrequency,
    features,
  };
}

/**
 * Publish every feature from one snapshot.
 *
 * A reading goes out with `state`, a state goes out with `text`. Those are the two
 * shapes Gladys validates against, and mixing them up is what left this device
 * half-populated twice — see the note at the top of the file.
 */
export async function publishAll(gladys, device, snapshot) {
  const ids = gladys.externalIds(PLATFORM_TYPE, platformId(device));
  for (const f of FEATURES) {
    const externalId = ids.feature(f.key);
    try {
      if (f.asText) {
        const text = featureText(f, snapshot);
        if (text === null) continue;
        await gladys.publishStates([{ device_feature_external_id: externalId, text }]);
        continue;
      }
      const value = featureValue(f, snapshot);
      if (value === null) continue;
      await gladys.publishStates([{ device_feature_external_id: externalId, state: value }]);
    } catch (err) {
      // One refused reading must not stop the others.
      logger.warn(`Could not publish ${f.name}: ${err.message}`);
    }
  }
}
