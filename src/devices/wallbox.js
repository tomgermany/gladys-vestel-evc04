// -----------------------------------------------------------------------------
// The wallbox as a Gladys device: which features exist, and how they are built.
//
// WHAT A FEATURE IS IN GLADYS
// A feature is one value of a device: the power, one phase current, the meter
// reading. It carries a name, an external id, a category, a type and a unit.
// Gladys files and displays it by its category, which is why the category has to be
// one Gladys knows: an unknown category is not a warning, it is a refusal of the
// WHOLE device.
//
// TWO KINDS OF FEATURE, AND WHY THEY ARE NOT INTERCHANGEABLE
// A READING (energy-sensor, type power/voltage/current/index) is published as a bare
// NUMBER. A STATE is not: Gladys validates its value and answers
//   states[0]: must have a numeric "state" or a string "text"
// when it gets anything else. What that message means, read from the core
// (server/lib/external-integration/externalIntegration.saveStates.js):
//
//   const hasNumericState = typeof state.state === 'number' && Number.isFinite(state.state);
//   const hasText = typeof state.text === 'string';
//   if (!hasNumericState && !hasText) throw new BadParameters(...)
//
// So a state value must be an OBJECT — { state: 2 } or { text: '...' } — and the SDK
// types it exactly that way in DeviceState. That is the mistake this file made
// twice: first a bare string, then a bare number. Both were refused, and a refused
// state leaves the device half-populated on every poll.
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
// EVERY FEATURE NAMES ITS SOURCE AND ITS SHAPE
// A feature row says where its value comes from (`source`) and how to read it (`as`):
//
//   'sentence'  the sentence built in src/labels.js from that state's WORD
//   'state'     the NUMBER of a { value, word } entry — see src/vestel/client.js
//   'number'    the bare reading, scaled if the device reports another unit
//
// Naming the source is what fixed the last two refusals. The two code features read
// `cable_state` and `chargepoint_state`, and the row key is not always the source:
// `cable_code` reads `cable_state`, and `charge_state` reads `chargepoint_state`.
// Reading `snapshot[feature.key]` therefore answered undefined for three of the four
// states, and undefined is neither a number nor a text.
//
// UNITS ARE CONVERTED ONCE, HERE
// The device reports current in milliamperes and the meter reading in tenths of a
// kilowatt-hour. Gladys stores amperes and kilowatt-hours, so both divisions happen
// on the way in, in this file.
//
// ONLY ONE FEATURE IS WRITABLE, AND IT SAYS SO
// `charging_current` is the single feature a user can set from Gladys. Everything
// else — the limits, the states, the meter — is a reading. The device has no start
// and no stop command, so there is nothing else TO write.
//
// THE DEVICE IS POLLED, AND THE RATE COMES FROM THE CONFIGURATION
// `should_poll: true` alone is not enough: the SDK states that Gladys schedules a
// device only with BOTH `should_poll` and a `poll_frequency`, the latter in
// MILLISECONDS and chosen from DEVICE_POLL_FREQUENCIES (1 s, 2 s, 10 s, 15 s, 30 s,
// 1 min) — any other value is refused with a 400.
//
// THE SLIDER BOUNDS COME FROM THE DEVICE, NOT FROM A CONSTANT
// `charging_current` carries `min` and `max`, and those are what a slider offers.
// They are NOT the fallbacks in registers.js when the device has answered its own
// limit registers: this wallbox reports 13 A as its ceiling, and a slider that
// offers 6–16 would let a user ask for a value the wallbox silently ignores. The
// caller therefore passes the limits it read, and the fallbacks only stand in for a
// device that answers those registers at all.
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
import { Evc04Client } from '../vestel/client.js';
// `stateSentence` is deliberately not imported here. The charge state goes through
// `deviceSentence`, which falls back to `stateSentence` INSIDE src/labels.js when the
// device is not charging; the cable state goes through `cableSentence`. An import
// that nothing in this file calls is an unused variable, and ESLint is right to say
// so — it was left behind when the state moved from numbers to words.
import { cableSentence, deviceSentence } from '../labels.js';

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
 *   source  : the snapshot key the value comes from. Not always the row key.
 *   as      : 'sentence' | 'state' | 'number' — see the note at the top.
 *   scale   : applied on the way in; keep it in step with `unit` or the numbers lie.
 *   writable: true when the user can set it from Gladys.
 *   bounds  : the row whose min/max follow the DEVICE's own limits. Only
 *             `charging_current` has it: it is the one feature a user can move, and
 *             the only one whose range the wallbox gets a say in.
 */
export const FEATURES = [
  // --- What the wallbox is doing, as the sentence a user reads ---
  {
    key: 'charge_state',
    name: 'Ladezustand',
    source: 'chargepoint_state',
    as: 'sentence',
    category: CAT.TEXT,
    type: TEXT,
    keep_history: false,
    writable: false,
  },
  {
    key: 'cable_state',
    name: 'Kabelzustand',
    source: 'cable_state',
    as: 'sentence',
    category: CAT.TEXT,
    type: TEXT,
    keep_history: false,
    writable: false,
  },

  // --- The same two states as numbers, for a scene to compare on ---
  // A text feature cannot be compared with a threshold, so the code stays available
  // as its own reading. It carries no unit: a code is not a quantity.
  {
    key: 'chargepoint_state',
    name: 'Ladezustand (Code)',
    source: 'chargepoint_state',
    as: 'state',
    category: CAT_ENERGY,
    type: POWER,
    keep_history: false,
    writable: false,
  },
  {
    key: 'cable_code',
    name: 'Kabelzustand (Code)',
    source: 'cable_state',
    as: 'state',
    category: CAT_ENERGY,
    type: POWER,
    keep_history: false,
    writable: false,
  },
  {
    key: 'charging',
    name: 'Lädt',
    source: 'charging_state',
    as: 'number',
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
    source: 'power',
    as: 'number',
    category: CAT_ENERGY,
    type: POWER,
    unit: UNIT.WATT,
    scale: 1,
    writable: false,
  },
  {
    key: 'current_l1',
    name: 'Ladestrom L1',
    source: 'current_l1',
    as: 'number',
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
    source: 'meter_reading',
    as: 'number',
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
    source: 'session_energy',
    as: 'number',
    category: CAT_ENERGY,
    type: ENERGY,
    unit: UNIT.KILOWATT_HOUR,
    // The device reports watt-hours.
    scale: 1 / 1000,
    writable: false,
  },

  // --- The limits the DEVICE reports, shown so the user can see them ---
  // Read-only on purpose. These are the installer's figures, and showing them is how
  // a user can tell why a setpoint of 16 A turned into 13: the wallbox says 13 is its
  // maximum. Nothing in Gladys can change them.
  {
    key: 'evse_max_current',
    name: 'Maximaler Ladestrom (Wallbox)',
    source: 'evse_max_current',
    as: 'number',
    category: CAT_ENERGY,
    type: CURRENT,
    unit: UNIT.AMPERE,
    scale: 1,
    writable: false,
  },
  {
    key: 'cable_max_current',
    name: 'Maximaler Ladestrom (Kabel)',
    source: 'cable_max_current',
    as: 'number',
    category: CAT_ENERGY,
    type: CURRENT,
    unit: UNIT.AMPERE,
    scale: 1,
    writable: false,
  },

  // --- The control ---
  // The charging current is the only thing this integration sets, because it is the
  // only thing the device can be told. It overrides what the wallbox would do on its
  // own, and the heartbeat in src/alive.js is what keeps it in force.
  //
  // `bounds: true` means the min and max below are only what stands in BEFORE the
  // device has answered; a caller that read the wallbox's limits overrides them. This
  // is what keeps the slider from offering a current the wallbox ignores.
  {
    key: 'charging_current',
    name: 'Ladestrom',
    source: 'charging_current',
    as: 'number',
    category: CAT_ENERGY,
    type: CURRENT,
    unit: UNIT.AMPERE,
    scale: 1,
    min: DEFAULT_MIN_CURRENT,
    max: DEFAULT_MAX_CURRENT,
    bounds: true,
    writable: true,
  },
];

/**
 * The platform id of ONE wallbox, and why it is not the name.
 *
 * Gladys keys history, scenes and dashboards on the external id, so it has to survive
 * a rename and stay unique when two charge points share an installation. The serial is
 * what the hardware reports; the host is only a fallback for a device that answers
 * nothing there.
 */
export const platformId = (device) => device.serial || device.host;

/**
 * The type segment of the external ids, deliberately empty.
 *
 * The SDK composes `ext:<selector>:<type>:<platformId>`, and Gladys checks that the id
 * starts with `ext:<selector>:`. The selector is the integration's own name, set by
 * the supervisor, and it is already in the id. Putting anything here would push the
 * platform id one segment to the right and Gladys would refuse the whole device.
 */
export const PLATFORM_TYPE = '';

/** The device external id, built by the SDK and never by hand. */
export function deviceExternalId(gladys, device) {
  return gladys.externalIds(PLATFORM_TYPE, platformId(device)).device;
}

/**
 * The value to publish for one feature, or null when the reading is missing.
 *
 * THE THREE SHAPES, IN ONE PLACE
 *   'sentence' — built from the state's WORD (src/labels.js)
 *   'state'    — the state's NUMBER
 *   'number'   — the bare reading, scaled if the device reports another unit
 *
 * Answering null leaves the feature out of the publication entirely, which is what
 * keeps a missing reading from being written as a zero. An object where a number is
 * expected is also null: the `{ value, word }` entries are only ever reached through
 * the two state branches.
 */
export function featureValue(feature, snapshot) {
  if (feature.as === 'sentence') {
    if (feature.source === 'chargepoint_state') {
      return deviceSentence({
        word: Evc04Client.stateWord(snapshot, 'chargepoint_state'),
        power: snapshot?.power ?? null,
        faultCode: snapshot?.fault_code ?? null,
      });
    }
    return cableSentence({ word: Evc04Client.stateWord(snapshot, 'cable_state') });
  }

  if (feature.as === 'state') {
    return Evc04Client.stateValue(snapshot, feature.source);
  }

  const raw = snapshot?.[feature.source];
  if (raw === undefined || raw === null || typeof raw === 'object') return null;
  if (feature.scale === undefined || feature.scale === 1) return raw;
  return Math.round(raw * feature.scale * 10000) / 10000;
}

/**
 * The range a feature is offered with.
 *
 * A row marked `bounds` follows the DEVICE's own limits when the caller read them,
 * and falls back to the row's constants when it did not. Those constants are the
 * smallest figures that make sense for a home charge point, not a generous guess: a
 * ceiling that is too high is a value the wallbox silently ignores, and the user
 * reads a number that is not true.
 */
export function featureBounds(feature, limits) {
  const min = Number(limits?.min);
  const max = Number(limits?.max);
  const known = Number.isFinite(min) && min > 0 && Number.isFinite(max) && max >= min;
  if (feature.bounds && known) return { min, max };
  return { min: feature.min ?? 0, max: feature.max ?? 0 };
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
 *
 * `limits` are the figures the WALLBOX reported for `1102`, `1104`, `1106` and
 * `1100` — see Evc04Client.readLimits(). They decide the slider range of the one
 * writable feature. Passing nothing is not an error: a device that does not answer
 * those registers keeps the fallbacks.
 */
export function buildDevice(gladys, device, snapshot, pollFrequency, limits = null) {
  const ids = gladys.externalIds(PLATFORM_TYPE, platformId(device));
  const features = [];

  for (const f of FEATURES) {
    if (featureValue(f, snapshot) === null) continue;
    const bounds = featureBounds(f, limits);
    features.push({
      name: f.name,
      external_id: ids.feature(f.key),
      category: f.category,
      type: f.type,
      unit: f.unit ?? null,
      min: bounds.min,
      max: bounds.max,
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
 * A reading goes out with `state`, a sentence with `text`. Those are the two shapes
 * Gladys validates against, and mixing them up is what left this device
 * half-populated twice — see the note at the top of the file.
 */
export async function publishAll(gladys, device, snapshot) {
  const ids = gladys.externalIds(PLATFORM_TYPE, platformId(device));
  for (const f of FEATURES) {
    const externalId = ids.feature(f.key);
    const value = featureValue(f, snapshot);
    if (value === null || value === undefined) continue;
    try {
      const entry =
        f.as === 'sentence'
          ? { device_feature_external_id: externalId, text: String(value) }
          : { device_feature_external_id: externalId, state: value };
      await gladys.publishStates([entry]);
    } catch (err) {
      // One refused reading must not stop the others.
      logger.warn(`Could not publish ${f.name}: ${err.message}`);
    }
  }
}
