// -----------------------------------------------------------------------------
// The wallbox as a Gladys device: the features it publishes, and how they are
// built.
//
// ONE FEATURE, BECAUSE ONE NUMBER IS WHAT THIS CARD IS FOR
// A user of a charging station wants to know with how many amperes the car is
// charging. That is the number this device publishes, and it is deliberate that it
// is the only one: twelve features of which three are read were a card nobody could
// read at a glance, and a device that offered more than it showed.
//
// EVERYTHING ELSE IS A DEVICE PROPERTY
// The identity strings, the firmware, the limits and the live meter reading are all
// read from the device and all worth keeping — but they belong in the integration's
// device properties, not in the feature list. `buildProperties()` below turns a
// reading into that list, and `deviceProperties()` turns the identity into the
// three values that are known before a poll has ever run.
//
// WHAT A FEATURE IS IN GLADYS
// A feature is one value of a device: a name, an external id, a category, a type and
// a unit. Gladys files and displays it by its category, which is why the category
// has to be one Gladys knows: an unknown category is not a warning, it is a refusal
// of the WHOLE device.
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
// because the sentence is still built, for the device properties, and because
// discarding the branch is how the next person reintroduces the mistake this file
// already made twice: first a bare string, then a bare number, both refused.
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
// `stateSentence` is deliberately not imported here: the charge state goes through
// `deviceSentence`, which falls back to it INSIDE src/labels.js. An import nothing in
// this file calls is an unused variable, and ESLint says so — it was left behind when
// the state moved from numbers to words.
import { cableSentence, deviceSentence, t } from '../labels.js';

const logger = createLogger({ name: 'wallbox' });

const CURRENT = TYPE.ENERGY?.CURRENT ?? 'current';

/**
 * The category of the one reading here.
 *
 * `energy-sensor` is the category that carries a charging station's current. It is
 * the only category in this file on purpose — a category Gladys does not know
 * refuses the whole device, and there is nothing else to file.
 */
const CAT_ENERGY = CAT.ENERGY_SENSOR;

/**
 * The one feature of this device: the amperes the car is drawing.
 *
 *   key     : the reading it carries, and the suffix of its external id. Never
 *             rename it: Gladys keys the history, the scenes and the dashboards on
 *             these ids.
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
 * The values that describe the DEVICE rather than measure it.
 *
 * WHAT BELONGS HERE, AND WHY IT IS NOT A FEATURE
 * A feature is filed in the history and drawn on a card. A device property is shown
 * on the integration's own page, which is where a user looks up a serial number or a
 * firmware and never looks for a charge. Mixing the two gave this device twelve
 * features of which most were unread.
 *
 * HOW A PROPERTY IS SHAPED
 * A property is `{ key, value }` in the platform's own vocabulary: a string, a
 * number, a boolean, an array of strings. `text` is accepted as a synonym for
 * `value`, and the pair also reads as `{ label, value }`. Every form below uses
 * `{ key, value }`, because that is the one that needs no interpretation.
 *
 * THE SHAPE IS THE PART I COULD NOT VERIFY
 * The SDK is not installable here, so the exact property vocabulary is read from
 * the documentation rather than from the package. `gladys.publishDeviceProperties`
 * sits behind `?.` at every call site for that reason: if the method or the name is
 * not what this build offers, the integration loses its properties and keeps
 * working, instead of failing to start over a diagnostic list.
 */
export function deviceProperties(device = {}) {
  return [
    { key: 'serial', value: device.serial ?? null },
    { key: 'model', value: device.model ?? null },
    { key: 'host', value: device.host ?? null },
  ].filter((entry) => entry.value !== null && entry.value !== '');
}

/**
 * The live reading, said in properties instead of features.
 *
 * ONE PROPERTY PER SNAPSHOT KEY, NAMED AFTER IT. The keys of the snapshot are the
 * register map's own vocabulary — `power`, `meter_reading`, `session_energy` — and
 * using them here means a value that appears in a poll can be looked up under the
 * name it was read with. A hand-made label per row would be a second vocabulary to
 * keep in step.
 *
 * `charging_current` deliberately arrives in AMPERES: the snapshot key names the
 * register, and a count of tenths is not the current. There is one conversion, and
 * it is the feature's `scale` — so the property reads five amperes where the
 * register reads fifty.
 */
const READING_LABELS = {
  power: 'Leistung (W)',
  current_l1: 'Strom L1 (A)',
  current_l2: 'Strom L2 (A)',
  current_l3: 'Strom L3 (A)',
  voltage_l1: 'Spannung L1 (V)',
  voltage_l2: 'Spannung L2 (V)',
  voltage_l3: 'Spannung L3 (V)',
  meter_reading: 'Zaehlerstand (kWh)',
  session_energy: 'Energie dieser Ladung (kWh)',
  session_duration: 'Dauer (s)',
  charging_current: 'Ladestrom laut Wallbox (A)',
};

/** How a raw reading is shown, per snapshot key. Everything else is passed through. */
const READING_SCALES = {
  current_l1: 1 / 1000,
  current_l2: 1 / 1000,
  current_l3: 1 / 1000,
  meter_reading: 1 / 10,
  session_energy: 1 / 1000,
  charging_current: 1 / 10,
};

/**
 * A reading as a number, scaled the one time its unit asks for.
 *
 * `null` means the device did not answer, and only that: a reading of 0 is a reading,
 * and register 1500 answers 0 whenever no charging session is running.
 */
export function readingProperty(key, snapshot) {
  const raw = Evc04Client.reading(snapshot, key);
  if (raw === null || raw === undefined) return null;
  const scale = READING_SCALES[key];
  if (scale === undefined || scale === 1) return raw;
  return Math.round(raw * scale * 10000) / 10000;
}

/**
 * One reading as one property.
 *
 * A key the device answers but this list does not name keeps its own name, so
 * nothing that was read is silently dropped. A key with no reading at all is left
 * out rather than reported as zero.
 */
export function buildProperties(device, snapshot) {
  if (!snapshot) return deviceProperties(device);
  const properties = deviceProperties(device);
  for (const key of Object.keys(snapshot)) {
    const value = readingProperty(key, snapshot);
    if (value === null || value === undefined) continue;
    properties.push({ key: READING_LABELS[key] ?? key, value });
  }
  return properties;
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
 * Publish the one feature from one snapshot, and the rest as properties.
 *
 * A reading goes out with `state` and a number; a sentence with `text`. Those are the
 * two shapes Gladys validates against. The sentence is no longer a feature of this
 * device, but the branch stays because the properties still carry it, and because
 * discarding it is how the earlier mistake gets reintroduced.
 *
 * The properties are published in the SAME pass, from the SAME snapshot, so a value
 * can never be in the history without being on the integration page or the other way
 * round.
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

  publishProperties(gladys, device, snapshot);
}

/**
 * Publish the device properties, and never let them take the poll down.
 *
 * A REFUSED PROPERTY IS NOT A FAILED POLL. The values on the integration page are a
 * convenience; the ampere reading is the device. So this is awaited nowhere and its
 * failure is logged, not thrown — the same rule `publishAll` follows per feature.
 */
export async function publishProperties(gladys, device, snapshot) {
  if (typeof gladys?.publishDeviceProperties !== 'function') return;
  const properties = buildProperties(device, snapshot);
  if (properties.length === 0) return;
  try {
    await gladys.publishDeviceProperties({ device_external_id: idsFor(gladys, device), properties });
  } catch (err) {
    logger.warn(`Could not publish device properties: ${err.message}`);
  }
}

/** The device external id, resolved here so both publishers agree on it. */
function idsFor(gladys, device) {
  return gladys.externalIds(PLATFORM_TYPE, platformId(device)).device;
}
