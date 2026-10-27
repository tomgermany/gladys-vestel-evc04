import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SCENE_ACTIONS, TRIGGER, chargingEvents, kilowattHours } from '../src/scenes.js';
import { CHARGER_WIDGET, chargerAction, ACTION, stepFromSettings, STEP_CHOICES, buildChargerContent } from '../src/widgets.js';
import { stateSentence, cableSentence, deviceSentence, t } from '../src/labels.js';
import { CHARGEPOINT_STATE, CABLE_STATE, POLL_PLAN } from '../src/vestel/registers.js';
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
  current_l2: 0,
  current_l3: 0,
  total_current: 0,
  voltage_l1: 230,
  voltage_l2: 230,
  voltage_l3: 230,
  power: 0,
  meter_reading: 123456,
  session_energy: 4321,
  session_duration: 3600,
  evse_max_current: 16,
  cable_max_current: 16,
  // Register 1500 counts tenths of an ampere: 130 is 13 A.
  charging_current: 130,
};


test('the manifest config defaults match DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema ?? []) {
    if (field.default !== undefined) {
      const manifestDefault =
        field.type === 'select' &&
        typeof DEFAULT_CONFIG[field.key] === 'number'
          ? Number(field.default)
          : field.default;

      assert.equal(
        DEFAULT_CONFIG[field.key],
        manifestDefault,
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
// helpers are the ONLY way the rest of the code reaches a value, and getting the shape
// wrong is what left the card saying "Zustand unbekannt." while the log said the state
// had been read.

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

test('a reading of 0 is a reading, not a missing value', () => {
  // Register 1500 answers 0 whenever no session is running, and register 1008 answers
  // 0 while a car draws nothing. Both are readings the device really gave, and both
  // must survive a shape test meant for states.
  assert.equal(Evc04Client.reading(snapshot, 'current_l1'), 0);
  assert.equal(Evc04Client.reading(snapshot, 'power'), 0);
  assert.equal(Evc04Client.reading(snapshot, 'charging_current'), 130);
});

// --- the properties of the device ---
// The DEVICE and the WIDGET are two different surfaces. This file's list is the
// device: everything Gladys files, keeps history for and shows on the device page.
// It was once cut down to the ampere reading alone, which left sixteen readings the
// poll plan fetched on every cycle unpublished. These tests hold the fuller list in
// place, and each one fails for a reason a reader can act on.

test('every property names a polled or derived source, and has a supported shape', () => {
  const polled = new Set(POLL_PLAN.map((entry) => entry.key));
  // total_current is calculated from the three polled phase currents in readAll();
  // it is deliberately not a Modbus register of its own.
  const derived = new Set(['total_current']);
  for (const f of FEATURES) {
    assert.ok(f.source, `property "${f.key}" names no source`);
    assert.ok(
      polled.has(f.source) || derived.has(f.source),
      `property "${f.key}" reads "${f.source}", which is neither polled nor derived`,
    );
    assert.ok(['number', 'state', 'sentence'].includes(f.as), `property "${f.key}" has no shape`);
  }
});

test('no two properties share a key', () => {
  const keys = FEATURES.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, `duplicate key in ${keys.join(', ')}`);
});

test('the unreliable register-1500 value is not published as a device feature', () => {
  assert.equal(FEATURES.some((f) => f.key === 'charging_current'), false);
  assert.ok(FEATURES.some((f) => f.key === 'total_current'));
});

test('the state is offered as a sentence and as a code', () => {
  const charge = FEATURES.find((f) => f.key === 'charge_state');
  const code = FEATURES.find((f) => f.key === 'chargepoint_state');
  const cable = FEATURES.find((f) => f.key === 'cable_state');
  assert.equal(featureValue(charge, snapshot), t('state_available'));
  assert.equal(featureValue(code, snapshot), 0);
  assert.equal(featureValue(cable, snapshot), t('cable_unplugged'));
});

test('whether the car is charging is its own property', () => {
  // This is the value the two scene triggers flank on. It has to be visible on the
  // device page, and it has to be a number so a scene can compare on it.
  const charging = FEATURES.find((f) => f.key === 'charging');
  assert.equal(featureValue(charging, snapshot), 0);
  assert.equal(featureValue(charging, { charging_state: 1 }), 1);
});

test('the units are converted once, where the row declares them', () => {
  const at = (key) => featureValue(FEATURES.find((f) => f.key === key), snapshot);
  // Milliamperes to amperes.
  assert.equal(at('current_l1'), 0);
  // The total is rounded to whole amperes for the published feature.
  assert.equal(featureValue(FEATURES.find((f) => f.key === 'total_current'), { total_current: 11.6 }), 12);
  // Register 1500 remains an internal widget-control value, not a published feature.
  assert.equal(Evc04Client.reading(snapshot, 'charging_current'), 130);
  // Tenths of a kilowatt-hour to kilowatt-hours.
  assert.equal(at('meter_reading'), 12345.6);
  // Watt-hours to kilowatt-hours.
  assert.equal(at('session_energy'), 4.321);
  // Volts and amperes pass through.
  assert.equal(at('voltage_l1'), 230);
  assert.equal(at('evse_max_current'), 16);
});

test('a missing reading leaves its property out rather than writing a zero', () => {
  const partial = { chargepoint_state: { value: 0, word: 'available' } };
  const power = FEATURES.find((f) => f.key === 'power');
  const charging = FEATURES.find((f) => f.key === 'charging');
  assert.equal(featureValue(power, partial), null);
  assert.equal(featureValue(charging, partial), null);
});

test('the device says it polls, and at the rate it was given', () => {
  const fakeGladys = {
    externalIds: () => ({ device: 'ext:x:y', feature: (k) => `ext:x:y:${k}` }),
  };
  const device = buildDevice(fakeGladys, { serial: 'S1', model: 'M' }, snapshot, 60000);
  assert.equal(device.should_poll, true);
  assert.equal(device.poll_frequency, 60000);
  // Every row finds something in this snapshot, so none is left out.
  assert.equal(device.features.length, FEATURES.length);
  // The reported register-1500 current is unreliable on this unit, so the
  // internal control reading is not offered as a duplicate device property.
  assert.equal(device.features.some((f) => f.external_id.endsWith(':charging_current')), false);
  assert.ok(device.features.some((f) => f.external_id.endsWith(':total_current')));
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


test('the widget shows a compact cable limit only when the cable maximum is lower', () => {
  const limited = buildChargerContent({
    state: snapshot,
    device: { name: 'Wallbox' },
    limits: { evseMax: 32, cableMax: 16, max: 16 },
    ids: {},
    t,
    sentence: () => 'Verfügbar – kein Fahrzeug angeschlossen.',
  });
  const item = limited.components[0].items.find((entry) => entry.label === t('current_limit'));
  assert.equal(item?.value, 'Kabel 16 A (Wallbox 32 A)');

  const unrestricted = buildChargerContent({
    state: snapshot,
    device: { name: 'Wallbox' },
    limits: { evseMax: 16, cableMax: 32, max: 16 },
    ids: {},
    t,
    sentence: () => 'Verfügbar – kein Fahrzeug angeschlossen.',
  });
  assert.equal(unrestricted.components[0].items.some((entry) => entry.label === t('current_limit')), false);
});

test('the widget shows total current as a tile and cable state as readable status text', () => {
  const content = buildChargerContent({
    state: snapshot,
    device: { name: 'Wallbox' },
    ids: { total_current: 'feature:total', cable_state: 'feature:cable' },
    controlled: 13,
    t,
    sentence: () => 'Verfügbar – kein Fahrzeug angeschlossen.',
    cableSentence: () => 'Kabel verriegelt.',
  });
  const tiles = content.components.filter((component) => component.type === 'value');
  assert.deepEqual(tiles.map((tile) => tile.device_feature), ['feature:total']);
  assert.deepEqual(tiles.map((tile) => tile.label), [t('current_total')]);
  assert.ok(content.components[0].items.some(
    (item) => item.label === t('cable') && item.value === 'Kabel verriegelt.',
  ));
});

// --- the widget buttons ---
// The card returns an intention and the caller applies it. There are two buttons, and
// they are the only control this device has.
//
// THE VALUES ARE COMPARED, NOT THE PROPERTY NAMES
// `Object.keys(ACTION)` returns the identifiers on the LEFT of the definition —
// `CURRENT_DOWN`, `CURRENT_UP` — and comparing those to the strings tested the wrong
// half of the object.
//
// THE READINGS HERE ARE WHOLE AMPERES
// The snapshot key is documented as amperes for this helper's callers, so a reading of
// 16 is 16 A. The register counts tenths, and that division happens once, in the row's
// scale — never here. Getting that wrong clamped every tap to the 6 A floor.

test('the widget carries exactly two action values, and neither of them releases', () => {
  assert.deepEqual(Object.values(ACTION).sort(), ['current_down', 'current_up']);
});

test('a tap on + moves the current up by one ampere from the reported reading', () => {
  const intent = chargerAction({
    actionKey: ACTION.CURRENT_UP,
    params: { step: 1 },
    state: { charging_current: 160 },
  });
  assert.equal(intent.current, 17);
});

test('the last controlled setpoint beats the unreliable register-1500 reading', () => {
  const intent = chargerAction({
    actionKey: ACTION.CURRENT_UP,
    params: { step: 1 },
    state: { charging_current: 0, total_current: 6.079 },
    controlled: 6,
  });
  assert.equal(intent.current, 7);
});

test('measured phase current is the fallback when register 1500 reports zero', () => {
  const intent = chargerAction({
    actionKey: ACTION.CURRENT_UP,
    params: { step: 1 },
    state: { charging_current: 0, current_l1: 9200, current_l2: 18, current_l3: 18 },
  });
  // 9.2 A measured on the strongest phase, plus one ampere. A fall back to the
  // 6 A floor would give 7.
  assert.equal(intent.current, 10);
});

test('the sum of the phases is not the base of a tap', () => {
  const intent = chargerAction({
    actionKey: ACTION.CURRENT_DOWN,
    params: { step: 1 },
    state: { charging_current: 0, current_l1: 16000, current_l2: 16000, current_l3: 16000 },
    limits: { min: 6, max: 16 },
  });
  assert.equal(intent.current, 15);
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

test('session max current does not override the configured EVSE and cable ceiling', async () => {
  const client = new Evc04Client({ host: 'wallbox.test', transport: { request: async () => {} } });
  const values = new Map([
    [1102, 6],
    [1104, 16],
    [1106, 32],
    [1100, 6],
  ]);
  client.readOptionalUint16 = async (address) => values.get(address) ?? null;

  const limits = await client.readLimits();
  assert.deepEqual(limits, { min: 6, max: 16, reportedMin: 6, evseMax: 16, cableMax: 32 });
});

test('a limit register that answers 0 does not lower the ceiling', async () => {
  const client = new Evc04Client({ host: 'wallbox.test', transport: { request: async () => {} } });
  const values = new Map([
    [1102, 0],
    [1104, 16],
    [1106, 0],
    [1100, 0],
  ]);
  client.readOptionalUint16 = async (address) => values.get(address) ?? null;

  const limits = await client.readLimits();
  assert.equal(limits.max, 16);
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

// --- the widget's own settings ---
// The step comes from the instance settings, so two cards can step differently. A
// setting nobody offered, or none at all, falls back instead of being trusted: the
// value comes out of a stored dashboard, which outlives the code that wrote it.

test('the step comes from the settings, inside the offered choices', () => {
  assert.equal(stepFromSettings({ step: 2 }), 2);
  assert.equal(stepFromSettings({ step: 5 }), 5);
  assert.equal(stepFromSettings({}), 1);
  assert.equal(stepFromSettings({ step: 3 }), 1, 'a step nobody offers falls back');
  assert.equal(stepFromSettings({ step: 'x' }), 1);
  for (const step of STEP_CHOICES) {
    assert.equal(stepFromSettings({ step }), step);
  }
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
