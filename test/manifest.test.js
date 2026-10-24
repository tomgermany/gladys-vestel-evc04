import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SCENE_ACTIONS, TRIGGER, chargingEvents, kilowattHours } from '../src/scenes.js';
import { CHARGER_WIDGET, chargerAction, ACTION } from '../src/widgets.js';
import { stateSentence, t } from '../src/labels.js';
import { CHARGEPOINT_STATE } from '../src/vestel/registers.js';

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

// --- the shape of this device -------------------------------------------------
// A wallbox has no start and no stop: a charge begins when the vehicle accepts the
// current. These two tests hold that shape in place, because it is the kind of
// thing an edit adds back without thinking — and a "release" action that writes a
// number is not a release.

test('the device offers exactly one scene action, and it sets the current', () => {
  assert.deepEqual(Object.keys(SCENE_ACTIONS), ['set_charging_current']);
  assert.equal(
    (manifest.scene_actions ?? []).length,
    1,
    'the manifest must declare exactly the one action this device can carry out',
  );
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
  assert.ok(declared.includes(CHARGER_WIDGET), `widget "${CHARGER_WIDGET}" is not declared`);
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

// --- the two scene triggers --------------------------------------------------
// "Started" and "finished" are the events a user builds automations on, and the
// flank is what makes them usable: a scene bound to the VALUE rather than to the
// change would fire on every poll for hours. These tests are what keeps that
// promise from being quietly broken by an edit.

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

// --- the widget buttons ------------------------------------------------------
// The card returns an intention and the caller applies it. That split is only
// worth anything if the intention itself is right, which is what these cover.
// There are two buttons, and they are the only control this device has.

test('the widget carries exactly two actions, and neither of them releases', () => {
  assert.deepEqual(Object.keys(ACTION).sort(), ['current_down', 'current_up']);
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
  assert.equal(intent.current, 16, 'a tap above the ceiling must stay at the ceiling');
});

test('an unknown action is refused rather than quietly ignored', () => {
  assert.throws(() => chargerAction({ actionKey: 'release' }), /Unknown widget action/);
});

// --- the labels --------------------------------------------------------------
// `t()` falls back to the key itself, so a missing text is not a crash: it is the
// literal key shown to the user. This caught exactly that once, in the
// WattWächter integration.
//
// THE STATE IS A NUMBER NOW
// The device's state is published as a number (see src/devices/wallbox.js), which
// is the only shape Gladys accepts for it. So the sentence lookup is tested with
// NUMBERS — one per state the specification lists — and not with the word, which
// is what this test used to pass and would have kept a dead path green.

test('every state code the device can report has a sentence', () => {
  for (const code of Object.keys(CHARGEPOINT_STATE)) {
    const sentence = stateSentence({ chargepoint_state: Number(code) });
    assert.notEqual(sentence, `state_${code}`, `no sentence for the state code ${code}`);
    assert.ok(sentence.length > 5, `the sentence for ${code} is too short to be useful`);
  }
});

test('an unknown state code says so instead of showing the key', () => {
  assert.equal(stateSentence({ chargepoint_state: 42 }), t('state_unknown'));
});
