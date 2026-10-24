import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SCENE_ACTIONS, TRIGGER, chargingEvents, kilowattHours } from '../src/scenes.js';
import { CHARGER_WIDGET, chargerAction, ACTION } from '../src/widgets.js';
import { stateSentence, cableSentence, deviceSentence, t } from '../src/labels.js';
import { CHARGEPOINT_STATE, CABLE_STATE } from '../src/vestel/registers.js';
import { Evc04Client } from '../src/vestel/client.js';
import { FEATURES, featureValue, buildDevice } from '../src/devices/wallbox.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const allFields = [
  ...(manifest.config_schema ?? []),
  ...(manifest.actions ?? []).flatMap((item) => item.fields ?? []),
  ...(manifest.scene_triggers ?? []).flatMap((item) => item.fields ?? []),
  ...(manifest.scene_actions ?? []).flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

/** A snapshot as the reader produces it: a state is `{ value, word }`. */
const snapshot = {
  chargepoint_state: { value: 0, word: 'available' },
  charging_state: 0,
  equipment_state: { value: 1, word: 'running' },
  cable_state: { value: 0, word: 'unplugged' },
  current_l1: 0,
  power: 0,
  meter_reading: 123456,
  session_energy: 4321,
  session_duration: 3600,
  evse_max_current: 16,
  cable_max_current: 16,
  charging_current: 13,
};

test('the manifest config defaults match DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema ?? []) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('the manifest and the package agree on the version', () => {
  assert.equal(manifest.version, pkg.version);
});

test('the image is tagged, on a registry, with a non-empty tag', () => {
  assert.match(manifest.docker_image, /^[a-z0-9.-]+\/\S+:[A-Za-z0-9._-]+$/);
});

test('the unit id of this device is the one the specification gives', () => {
  assert.equal(DEFAULT_CONFIG.unit_id, 255);
});

test('every scene action in the code is declared in the manifest, and vice versa', () => {
  const declared = (manifest.scene_actions ?? []).map((action) => action.key);
  for (const key of declared) {
    assert.equal(typeof SCENE_ACTIONS[key], 'function', `scene action "${key}" has no handler`);
  }
  for (const key of Object.keys(SCENE_ACTIONS)) {
    assert.ok(declared.includes(key), `scene action "${key}" is not declared in the manifest`);
  }
});

// --- the shape of this device ---
// A wallbox has no start and no stop: a charge begins when the vehicle accepts the
// current. These hold that shape in place, because it is the kind of thing an edit
// adds back without thinking — and a "release" action that writes a number is not a
// release.

test('the device offers exactly one scene action, and it sets the current', () => {
  assert.deepEqual(Object.keys(SCENE_ACTIONS), ['set_charging_current']);
  assert.equal((manifest.scene_actions ?? []).length, 1);
});

test('there is no release action, in the code nor in the manifest', () => {
  assert.equal(SCENE_ACTIONS.release_charging_current, undefined);
  assert.equal(ACTION.RELEASE, undefined);
  const declared = (manifest.scene_actions ?? []).map((action) => action.key);
  assert.ok(!declared.includes('release_charging_current'));
});

test('both triggers the code fires are declared', () => {
  const declared = (manifest.scene_triggers ?? []).map((trigger) => trigger.key);
  assert.ok(declared.includes(TRIGGER.CHARGING_STARTED));
  assert.ok(declared.includes(TRIGGER.CHARGING_FINISHED));
  assert.equal(declared.length, 2);
});

test('the widget key has a handler in the code', () => {
  const declared = (manifest.widgets ?? []).map((widget) => widget.key);
  assert.ok(declared.includes(CHARGER_WIDGET));
  assert.equal(declared.length, 1);
});

test('every select field offers options or a dynamic source', () => {
  for (const field of allFields.filter((f) => f.type === 'select')) {
    if (field.source) {
      assert.ok(typeof field.source === 'string' && field.source.length > 0);
      continue;
    }
    assert.ok(Array.isArray(field.options) && field.options.length > 0, field.key);
    for (const option of field.options) {
      assert.ok(option.label?.en, `option "${option.value}" needs an English label`);
    }
  }
});

// --- the snapshot shape ---
// A state is stored as `{ value, word }` by the reader (src/vestel/client.js). These
// two helpers are the ONLY way the rest of the code reaches a state, and getting the
// shape wrong is what left the card saying "Zustand unbekannt." while the log said the
// state had been read.

test('a state comes back as its number and its word', () => {
  assert.equal(Evc04Client.stateValue(snapshot, 'chargepoint_state'), 0);
  assert.equal(Evc04Client.stateWord(snapshot, 'chargepoint_state'), 'available');
  assert.equal(Evc04Client.stateWord(snapshot, 'cable_state'), 'unplugged');
});

test('a bare number still answers both, from the table', () => {
  // A snapshot from an older reader must not lose its word: the table is the
  // fallback, and without it a sentence would be built from nothing.
  assert.equal(Evc04Client.stateValue({ chargepoint_state: 2 }, 'chargepoint_state'), 2);
  assert.equal(Evc04Client.stateWord({ chargepoint_state: 2 }, 'chargepoint_state'), 'charging');
});

test('a missing state answers null and invents nothing', () => {
  assert.equal(Evc04Client.stateValue({}, 'chargepoint_state'), null);
  assert.equal(Evc04Client.stateWord({}, 'chargepoint_state'), null);
  assert.equal(Evc04Client.stateValue(snapshot, 'nothing_here'), null);
});

// --- the features against the snapshot ---
// Every row names its source and its shape. Reading `snapshot[feature.key]` instead
// answered undefined for three of the four state rows — `cable_code` reads
// `cable_state`, and `charge_state` reads `chargepoint_state` — and undefined is
// neither a number nor a text, which Gladys refuses outright.

test('every feature finds its source in the snapshot', () => {
  for (const f of FEATURES) {
    assert.ok(f.source, `feature "${f.key}" names no source`);
    assert.ok(['number', 'state', 'sentence'].includes(f.as), `feature "${f.key}" has no shape`);
    assert.notEqual(featureValue(f, snapshot), null, `feature "${f.key}" found nothing`);
  }
});

test('the two sentences are the sentence, not the code', () => {
  const charge = FEATURES.find((f) => f.key === 'charge_state');
  const cable = FEATURES.find((f) => f.key === 'cable_state');
  assert.equal(featureValue(charge, snapshot), t('state_available'));
  assert.equal(featureValue(cable, snapshot), t('cable_unplugged'));
});

test('the two code features carry the number', () => {
  const chargeCode = FEATURES.find((f) => f.key === 'chargepoint_state');
  const cableCode = FEATURES.find((f) => f.key === 'cable_code');
  assert.equal(featureValue(chargeCode, snapshot), 0);
  assert.equal(featureValue(cableCode, snapshot), 0);
});

test('a missing reading leaves its feature out rather than writing a zero', () => {
  const partial = { chargepoint_state: { value: 0, word: 'available' } };
  const power = FEATURES.find((f) => f.key === 'power');
  const charge = FEATURES.find((f) => f.key === 'charge_state');
  assert.equal(featureValue(power, partial), null);
  assert.equal(featureValue(charge, partial), t('state_available'));
});

test('the device says it polls, and at the rate it was given', () => {
  const fakeGladys = {
    externalIds: () => ({ device: 'ext:x:y', feature: (k) => `ext:x:y:${k}` }),
  };
  const device = buildDevice(fakeGladys, { serial: 'S1', model: 'M' }, snapshot, 30000);
  assert.equal(device.should_poll, true);
  assert.equal(device.poll_frequency, 30000);
  assert.equal(device.features.length, FEATURES.length);
});

// --- the two scene triggers ---
// "Started" and "finished" are the events a user builds automations on, and the flank
// is what makes them usable: a scene bound to the VALUE rather than to the change
// would fire on every poll for hours.

test('the first reading fires nothing: after a restart the state is unknown', () => {
  const { events, side } = chargingEvents({ snapshot: { charging_state: 1 }, previous: null });
  assert.deepEqual(events, []);
  assert.equal(side, 1);
});

test('an unchanged state fires nothing', () => {
  const { events } = chargingEvents({ snapshot: { charging_state: 1 }, previous: 1 });
  assert.deepEqual(events, []);
});

test('the transition into charging fires "started" once', () => {
  const { events, side } = chargingEvents({
    snapshot: { charging_state: 1, power: 11000, current_l1: 16000, meter_reading: 123456 },
    previous: 0,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].key, TRIGGER.CHARGING_STARTED);
  assert.equal(events[0].data.power, 11000);
  assert.equal(events[0].data.current, 16);
  assert.equal(events[0].data.energy, 12.346);
  assert.equal(side, 1);
});

test('the transition out of charging fires "finished" with the session figures', () => {
  const { events, side } = chargingEvents({
    snapshot: {
      charging_state: 0,
      meter_reading: 123456,
      session_energy: 4321,
      session_duration: 3600,
    },
    previous: 1,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].key, TRIGGER.CHARGING_FINISHED);
  assert.equal(events[0].data.energy, 12.346);
  assert.equal(events[0].data.session_energy, 4.321);
  assert.equal(events[0].data.duration, 3600);
  assert.equal(side, 0);
});

test('the kilowatt-hour conversion uses the step of the source register', () => {
  // The meter reading counts 0.1 kWh, the session energy counts Wh.
  assert.equal(kilowattHours(123456, 10), 12.346);
  assert.equal(kilowattHours(4321, 1), 4.321);
  assert.equal(kilowattHours(undefined, 1), null);
});

// --- the widget buttons ---
// The card returns an intention and the caller applies it. There are two buttons, and
// they are the only control this device has.
//
// THE VALUES ARE COMPARED, NOT THE PROPERTY NAMES
// `Object.keys(ACTION)` returns the identifiers on the LEFT of the definition —
// `CURRENT_DOWN`, `CURRENT_UP` — and comparing those to the strings tested the wrong
// half of the object.

test('the widget carries exactly two action values, and neither of them releases', () => {
  assert.deepEqual(Object.values(ACTION).sort(), ['current_down', 'current_up']);
});

test('a tap on + moves the current up by one ampere from what the user sees', () => {
  const intent = chargerAction({
    actionKey: ACTION.CURRENT_UP,
    params: { step: 1 },
    state: { charging_current: 16 },
  });
  assert.equal(intent.current, 17);
});

test('a tap on − moves the current down and stops at the floor', () => {
  const down = chargerAction({
    actionKey: ACTION.CURRENT_DOWN,
    params: { step: 1 },
    state: { charging_current: 16 },
  });
  assert.equal(down.current, 15);

  const floor = chargerAction({
    actionKey: ACTION.CURRENT_DOWN,
    params: { step: 1 },
    state: { charging_current: 6 },
  });
  assert.equal(floor.current, 6);
});

test('a tap can never leave the range the device reported', () => {
  const intent = chargerAction({
    actionKey: ACTION.CURRENT_UP,
    params: { step: 1 },
    state: { charging_current: 16 },
    limits: { min: 6, max: 16 },
  });
  assert.equal(intent.current, 16);
});

test('an unknown action is refused rather than quietly ignored', () => {
  assert.throws(() => chargerAction({ actionKey: 'release' }), /Unknown widget action/);
});

// --- the labels ---
// The sentences take the state's WORD, which the reader produced. Every state of the
// specification is therefore checked by its word, and none of them may come back as
// the bare key. That is the check the first real start failed: the card showed
// `state_0`.

test('every state word the device can report has a sentence', () => {
  for (const word of Object.values(CHARGEPOINT_STATE)) {
    const sentence = stateSentence({ word });
    assert.notEqual(sentence, `state_${word}`, `no sentence for the state "${word}"`);
    assert.ok(sentence.length > 5, `the sentence for "${word}" is too short`);
  }
});

test('every cable word the device can report has a sentence', () => {
  for (const word of Object.values(CABLE_STATE)) {
    const sentence = cableSentence({ word });
    assert.notEqual(sentence, `cable_${word}`, `no sentence for the cable "${word}"`);
    assert.ok(sentence.length > 5, `the sentence for cable "${word}" is too short`);
  }
});

test('an unknown or missing state says so instead of showing the key', () => {
  assert.equal(stateSentence({ word: null }), t('state_unknown'));
  assert.equal(cableSentence({ word: null }), t('state_unknown'));
});

test('the charging sentence names the power, and only that one does', () => {
  const charging = deviceSentence({ word: 'charging', power: 11000 });
  assert.match(charging, /11 kW/);

  const available = deviceSentence({ word: 'available', power: 0 });
  assert.equal(available, t('state_available'));
});

test('a fault sentence carries the fault code', () => {
  const faulted = deviceSentence({ word: 'faulted', faultCode: 7 });
  assert.match(faulted, /7/);
});
