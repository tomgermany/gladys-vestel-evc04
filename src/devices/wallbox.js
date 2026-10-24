// -----------------------------------------------------------------------------
// The wallbox as a Gladys device: the one feature it publishes, and how it is built.
//
// ONE FEATURE, BECAUSE ONE NUMBER IS WHAT THIS CARD IS FOR
// A user of a charging station wants to know with how many amperes the car is
// charging. That is the number this device publishes, and it is deliberate that it is
// the only one: twelve features of which three were read were a card nobody could
// read at a glance, and a device that offered more than it showed.
//
// WHAT THIS FILE DOES NOT DO ANYMORE
// It used to build a property list for the integration page — identity, firmware, the
// live meter readings. The SDK has no device-property API, so that list had nothing
// to publish it and was removed rather than left as a promise the code could not
// keep. The identity is still read and still used: it is what `platformId()` keys the
// external id on.
//
// WHAT A FEATURE IS IN GLADYS
// A feature is one value of a device: a name, an external id, a category, a type and a
// unit. Gladys files and displays it by its category, which is why the category has to
// be one Gladys knows: an unknown category is not a warning, it is a refusal of the
// WHOLE device.
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
// The one feature here is a READING, so it goes out with `state` and a number:
//
//   { device_feature_external_id, state: 13 }
//
// `publishAll` keeps the text branch — a sentence is the shape a state would need —
// so that the mistake this file already made twice is not reintroduced by a future
// edit: first a bare string, then a bare number, both refused.
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
import { DEFAULT_MIN_CURRENT, DEFAULT_MAX_CURRENT } from '../vestel/registers.js';
import { Evc04Client } from '../vestel/client.js';
// `stateSentence` and `t` are deliberately not imported here: the charge state goes
// through `deviceSentence`, which falls back to `stateSentence` INSIDE src/labels.js,
// and nothing in this file looks a text up by key. Imports that nothing calls are
// unused variables, and ESLint is right to say so.
import { cableSentence, deviceSentence } from '../labels.js';

const logger = createLogger({ name: 'wallbox' });

const CURRENT = TYPE.ENERGY?.CURRENT ?? 'current';

/**
 * The category of the one reading here.
 *
 * `energy-sensor` is the category that carries a charging station's current. It is
 * the only category in this file on purpose — a category Gladys does not know refuses
 * the whole device, and there is nothing else to file.
 */
const CAT_ENERGY = CAT.ENERGY_SENSOR;

/**
 * The one feature of this device: the amperes the car is drawing.
 *
 *   key     : the reading it carries, and the suffix of its external id. Never rename
 *             it: Gladys keys the history, the scenes and the dashboards on these ids.
 *   source  : the snapshot key the value comes from. Not always the row key.
 *   scale   : applied on the way in. Register 1500 counts TENTHS of an ampere, and
 *             Gladys stores amperes, so the division happens here — once, where the
 *             unit is declared, and never a second time at a call site.
 *   writable: true, because the current is the one thing a user can set.
 *   bounds  : the row whose min/max follow the DEVICE's own limits.
 */
export const FEATURES = [
  {
    key: 'charging_current',
    name: 'Ladestrom',
    source: 'charging_current',
    as: 'number',
    category: CAT_ENERGY,
    type: CURRENT,
    unit: UNIT.AMPERE,
    // Register 1500 counts tenths of an ampere: 130 is 13 A.
    scale: 1 / 10,
    min: DEFAULT_MIN_CURRENT,
    max: DEFAULT_MAX_CURRENT,
    bounds: true,
    writable: true,
  },
];

/**
 * The platform id of ONE wallbox, and why it is not the name.
 *
 * Gladys keys history, scenes and dashboards on the external id, so it has to
 * survive a rename and stay unique when two charge points share an installation. The
 * serial is what the hardware reports; the host is only a fallback for a device that
 * answers nothing there.
 */
export const platformId = (device) => device.serial || device.host;

/**
 * The type segment of the external ids, deliberately empty.
 *
 * The SDK composes `ext:<selector>:<type>:<platformId>`, and Gladys checks that the
 * id starts with `ext:<selector>:`. The selector is the integration's own name, set
 * by the supervisor, and it is already in the id. Putting anything here would push
 * the platform id one segment to the right and Gladys would refuse the whole device.
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
 * Build the discovery payload: "here is a wallbox, with this reading".
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
