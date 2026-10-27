// -----------------------------------------------------------------------------
// The wallbox as a Gladys DEVICE: the properties it shows on its own page.
//
// THE DEVICE AND THE WIDGET ARE TWO DIFFERENT SURFACES
// This file builds the device: the list of values Gladys files, keeps history for and
// shows on the device page. The dashboard card is a second, separate surface, built
// in src/widgets.js — and it deliberately shows only the charging current and the
// state sentence, because that is what a wallbox owner looks at.
///
// An earlier version of this file cut the list down to the ampere reading alone, on
// the reasoning that "the widget shows one number". That reasoning applied to the
// widget and was applied to the device: sixteen readings the poll plan fetched on
// every cycle were then dropped before publication, so the device page offered one
// value while the wallbox reported seventeen.
//
// WHAT A FEATURE IS IN GLADYS
// A feature is one value of a device: a name, an external id, a category, a type and
// a unit. Gladys files and displays it by its category, which is why the category has
// to be one Gladys knows: an unknown category is not a warning, it is a refusal of
// the WHOLE device.
//
// TWO KINDS OF VALUE, AND WHY THEY ARE NOT INTERCHANGEABLE
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
// So a state value must be an OBJECT — { state: 2 } or { text: '...' }. The charging
// state goes out as TEXT, because the sentence a user reads is already built in
// src/labels.js, and as its NUMBER next to it, because a text feature cannot be
// compared with a threshold in a scene. The mistake this file made twice — first a
// bare string, then a bare number — is what the shape column below exists to prevent.
//
// EVERY FEATURE NAMES ITS SOURCE AND ITS SHAPE
//   key     : the reading it carries, and the suffix of its external id. Never rename
//             it: Gladys keys the history, the scenes and the dashboards on these ids.
//   source  : the snapshot key the value comes from. Not always the row key.
//   as      : 'sentence' | 'state' | 'number' — see featureValue().
//   scale   : applied on the way in. Keep it in step with `unit` or the numbers lie.
//   bounds  : the one row whose min/max follow the DEVICE's own limits.
//   writable: true only for the current, the one thing a user can set.
//
// THE DEVICE IS POLLED, AND THE RATE COMES FROM THE CONFIGURATION
// `should_poll: true` alone is not enough: the SDK states that Gladys schedules a
// device only with BOTH `should_poll` and a `poll_frequency`, the latter in
// MILLISECONDS and chosen from DEVICE_POLL_FREQUENCIES (1 s, 2 s, 10 s, 15 s, 30 s,
// 1 min) — any other value is refused with a 400.
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
import { Evc04Client } from '../vestel/client.js';
import { cableSentence, deviceSentence } from '../labels.js';

const logger = createLogger({ name: 'wallbox' });

const POWER = TYPE.ENERGY?.POWER ?? 'power';
const ENERGY = TYPE.ENERGY?.INDEX ?? 'index';
const CURRENT = TYPE.ENERGY?.CURRENT ?? 'current';
const VOLTAGE = TYPE.ENERGY?.VOLTAGE ?? 'voltage';
const TEXT = TYPE.TEXT?.TEXT ?? 'text';

/**
 * The category of every reading here.
 *
 * `energy-sensor` is the category that carries a metering device: power, energy,
 * voltage, current, index. It is the only energy category in this file on purpose —
 * a category Gladys does not know refuses the whole device, and there is nothing else
 * to file.
 */
const CAT_ENERGY = CAT.ENERGY_SENSOR;

/**
 * One row per property of the device.
 *
 * THE ORDER IS THE ORDER A READER SEES THEM: what the wallbox is doing first, then
 * the live electrical figures, then the totals, then the limits the device itself
 * reports. The limits read-only on purpose — an installer set them, and showing them
 * is how a user can tell why a setpoint of 16 A became 13.
 */
export const FEATURES = [
  // --- What the wallbox is doing: a sentence, and the same state as a code ---
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
    key: 'cable_state',
    name: 'Kabelzustand',
    source: 'cable_state',
    as: 'sentence',
    category: CAT.TEXT,
    type: TEXT,
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

  // --- The live electrical reading ---
  {
    key: 'total_current',
    name: 'Ladestrom gesamt',
    source: 'total_current',
    as: 'number',
    category: CAT_ENERGY,
    type: CURRENT,
    unit: UNIT.AMPERE,
    // The snapshot keeps the precise sum; Gladys displays whole amperes.
    scale: 1,
    writable: false,
  },
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
  {
    key: 'current_l2',
    name: 'Ladestrom L2',
    source: 'current_l2',
    as: 'number',
    category: CAT_ENERGY,
    type: CURRENT,
    unit: UNIT.AMPERE,
    scale: 1 / 1000,
    writable: false,
  },
  {
    key: 'current_l3',
    name: 'Ladestrom L3',
    source: 'current_l3',
    as: 'number',
    category: CAT_ENERGY,
    type: CURRENT,
    unit: UNIT.AMPERE,
    scale: 1 / 1000,
    writable: false,
  },
  {
    key: 'voltage_l1',
    name: 'Spannung L1',
    source: 'voltage_l1',
    as: 'number',
    category: CAT_ENERGY,
    type: VOLTAGE,
    unit: UNIT.VOLT,
    scale: 1,
    writable: false,
  },
  {
    key: 'voltage_l2',
    name: 'Spannung L2',
    source: 'voltage_l2',
    as: 'number',
    category: CAT_ENERGY,
    type: VOLTAGE,
    unit: UNIT.VOLT,
    scale: 1,
    writable: false,
  },
  {
    key: 'voltage_l3',
    name: 'Spannung L3',
    source: 'voltage_l3',
    as: 'number',
    category: CAT_ENERGY,
    type: VOLTAGE,
    unit: UNIT.VOLT,
    scale: 1,
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

  // The setpoint is kept as an internal snapshot value for the widget's +/−
  // buttons, but is not published as a device feature. Register 1500 reports 0 A
  // on this wallbox, so showing it as a second "Ladestrom" property is misleading.

];

/**
 * The platform id of ONE wallbox, and why it is not the name.
 *
 * Gladys keys history, scenes and dashboards on the external id, so it has to survive
 * a rename and stay unique when two charge points share an installation. The serial is
 * what the hardware reports; the host is the fallback for a device that answers
 * nothing there — and on the reference unit the identity strings come back empty, so
 * that fallback is the one in use.
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
 * THE SHAPE IS DECIDED BY THE ROW, NEVER BY A `typeof` GUESS
 * A state row goes through `stateValue`, which knows that its entry is
 * `{ value, word }`; a reading row goes through `Evc04Client.reading`, which knows
 * that its entry is a bare number. Testing the entry's shape here instead is what
 * turned a genuine reading of 0 into `null` — `0` was mistaken for "nothing was
 * read".
 *
 * Answering null leaves the feature out of the publication entirely, which is what
 * keeps a missing reading from being written as a zero.
 */
export function featureValue(feature, snapshot) {
  if (feature.as === 'sentence') {
    if (feature.source === 'chargepoint_state') {
      return deviceSentence({
        word: Evc04Client.stateWord(snapshot, 'chargepoint_state'),
        power: Evc04Client.reading(snapshot, 'power'),
        faultCode: Evc04Client.reading(snapshot, 'fault_code'),
      });
    }
    return cableSentence({ word: Evc04Client.stateWord(snapshot, 'cable_state') });
  }

  if (feature.as === 'state') {
    return Evc04Client.stateValue(snapshot, feature.source);
  }

  const raw = Evc04Client.reading(snapshot, feature.source);
  if (raw === null || raw === undefined) return null;
  // The total is calculated precisely from all phases in the client, but the
  // displayed Gladys feature is intentionally a whole number of amperes.
  if (feature.source === 'total_current') return Math.round(raw);
  if (feature.scale === undefined || feature.scale === 1) return raw;
  return Math.round(raw * feature.scale * 10000) / 10000;
}

/**
 * The range a feature is offered with.
 *
 * A row marked `bounds` follows the DEVICE's own limits when the caller read them,
 * and falls back to the row's constants when it did not. Those constants are the
 * smallest figures that make sense for a home charge point: a ceiling that is too
 * high is a value the wallbox silently ignores, and the user reads a number that is
 * not true.
 */
export function featureBounds(feature, limits) {
  const min = Number(limits?.min);
  const max = Number(limits?.max);
  const known = Number.isFinite(min) && min > 0 && Number.isFinite(max) && max >= min;
  if (feature.bounds && known) return { min, max };
  return { min: feature.min ?? 0, max: feature.max ?? 0 };
}

/**
 * Build the discovery payload: "here is a wallbox, with these properties".
 *
 * Gladys creates nothing from this. It is an offer shown in the Discovery tab, where
 * the user clicks to create the device.
 *
 * `pollFrequency` is the rate the user chose, in milliseconds, and one of the values
 * Gladys accepts. It is passed in rather than fixed here, so the configuration screen
 * is what decides how often the wallbox is read.
 *
 * `limits` are the figures the WALLBOX reported for `1102`, `1104`, `1106` and `1100`
 * — see Evc04Client.readLimits(). They decide the slider range of the one writable
 * feature. Passing nothing is not an error: a device that does not answer those
 * registers keeps the fallbacks.
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
 * A reading goes out with `state` and a number; a sentence with `text`. Those are the
 * two shapes Gladys validates against, and mixing them up is what left this device
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
