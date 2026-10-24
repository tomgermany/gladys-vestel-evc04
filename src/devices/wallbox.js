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
// THE TEXT FEATURE THAT WAS ONE, AND WHAT IT COST
// The charge state and the cable state were published as TEXT features at first,
// and Gladys refused them with:
//   Could not publish Kabelzustand: states[0]: must have a numeric "state" or a
//   string "text"
// The value was a bare string, which the validation does not accept — and because
// the state was refused, the device stayed half-populated on every poll. Both are
// published as NUMBERS now, with the word kept for the sentence on the card.
//
// WHICH FEATURES EXIST IS DECIDED BY THE DEVICE
// The builder only makes a feature for a key the wallbox really answered. A
// three-phase charge point that reports no current on L3 gets no L3 feature, and
// the interface never shows a zero that would be wrong.
//
// UNITS ARE CONVERTED ONCE, HERE
// The device reports current in milliamperes and the meter reading in tenths of a
// kilowatt-hour. Gladys stores amperes and kilowatt-hours, so both divisions
// happen on the way in — in this file, so a scene and the interface cannot
// disagree about the unit of the same number.
//
// ONLY ONE FEATURE IS WRITABLE, AND IT SAYS SO
// `charging_current` is the single feature a user can set from Gladys. Everything
// else — the limits, the states, the meter — is a reading. The device has no start
// and no stop command, so there is nothing else TO write.
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

const logger = createLogger({ name: 'wallbox' });

const POWER = TYPE.ENERGY?.POWER ?? 'power';
const ENERGY = TYPE.ENERGY?.INDEX ?? 'index';
const CURRENT = TYPE.ENERGY?.CURRENT ?? 'current';

/**
 * The category of every reading here.
 *
 * `energy-sensor` is the category that carries a three-phase meter: power,
 * energy, voltage, current, index. It is the only energy category in this file on
 * purpose — a second one would have to be a category Gladys knows, and the whole
 * device is refused if it is not.
 */
const CAT_ENERGY = CAT.ENERGY_SENSOR;

/**
 * One row per feature.
 *
 *   key     : the reading it carries, and the suffix of its external id. Never
 *             rename it: Gladys keys the history, the scenes and the dashboards
 *             on these ids.
 *   scale   : applied on the way in; keep it in step with `unit` or the numbers
 *             lie.
 *   writable: true when the user can set it from Gladys.
 *
 * A STATE IS A NUMBER, NOT A WORD
 * `chargepoint_state` and `cable_state` are published as plain numbers. The word
 * is what the CARD shows, built in src/labels.js; Gladys stores the number, which
 * is the only thing its validation accepts for a state. The unit is left out so the
 * interface shows the bare figure next to a name that says it is a code.
 */
export const FEATURES = [
  // --- What the wallbox is doing ---
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
    key: 'cable_state',
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
  // The charging current is the only thing this integration sets, because it is
  // the only thing the device can be told. It overrides what the wallbox would do
  // on its own, and the heartbeat in src/alive.js is what keeps it in force.
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
 * The serial is what the hardware reports; the host is only a fallback for a
 * device that answers nothing there.
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
 * thing every consumer wants: a flag that says whether energy is flowing right
 * now, which is also the value the two scene triggers watch.
 */
export function decorate(snapshot = {}) {
  if (!snapshot || Object.keys(snapshot).length === 0) return snapshot;
  return {
    ...snapshot,
    charging: snapshot.charging_state === 1 ? 1 : 0,
  };
}

/**
 * Build the discovery payload: "here is a wallbox, with these readings".
 *
 * Gladys creates nothing from this. It is an offer shown in the Discovery tab,
 * where the user clicks to create the device.
 */
export function buildDevice(gladys, device, snapshot) {
  const ids = gladys.externalIds(PLATFORM_TYPE, platformId(device));
  const features = [];

  for (const f of FEATURES) {
    if (featureValue(f, snapshot) === null) continue;
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
    features,
  };
}

/** Publish the value of every feature from one snapshot. */
export async function publishAll(gladys, device, snapshot) {
  const ids = gladys.externalIds(PLATFORM_TYPE, platformId(device));
  for (const f of FEATURES) {
    const value = featureValue(f, snapshot);
    if (value === null) continue;
    try {
      await gladys.publishState(ids.feature(f.key), value);
    } catch (err) {
      // One refused reading must not stop the others.
      logger.warn(`Could not publish ${f.name}: ${err.message}`);
    }
  }
}
