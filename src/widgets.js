// -----------------------------------------------------------------------------
// The dashboard widget "Wallbox".
//
// WHAT A WIDGET IS HERE
// A small card on the dashboard. This file builds its CONTENT; the Gladys core
// renders it. No HTML, no CSS, no script: the content is a declarative tree of
// components in a small vocabulary, and the core normalises and translates it.
//
// THE ONE SENTENCE, WHICH IS THE WHOLE POINT
// The card does not show "Ladezustand: 2". It says what is happening: "Ich lade
// aktuell mit 11 kW." That sentence is the first thing on the card.
//
// WHY THE CARD STILL SHOWS A CONTROL
// The wallbox has no start and no stop — a charge begins when the vehicle accepts
// the current. The ONE thing that can be steered from here is how much current the
// vehicle may draw, and that is what these two buttons do.
//
// WHY THERE IS NO RELEASE BUTTON
// An earlier version had one, and it was wrong twice over: the device has no such
// state, and a button that only writes a different number is not a release. Whoever
// wants another current taps + or −.
//
// WHY THERE IS NO `settings` PARAMETER
// There is one wallbox, and the card shows it. A per-instance setting would only
// choose between several devices, and this integration publishes one. A parameter
// nobody reads is how a lint rule gets silenced instead of obeyed.
//
// THE BUDGET — why the order below is a decision
// A card takes at most 8 components, and among them at most 4 BUTTONS, 6 value
// tiles, 2 texts and 1 status list. Anything past a cap is DROPPED, in content
// order, silently. So the sentence comes first, then the values a user actually
// looks at, then the two buttons.
//
// THE TILES ARE BOUND TO FEATURES, NOT TO NUMBERS
// A tile with `device_feature` carries the external id of a published feature,
// and Gladys reads that feature's own value and history. It therefore stays right
// by itself and needs nothing from here.
//
// THE BUTTON TARGET COMES FROM THE SNAPSHOT, NOT FROM THE PUBLISHED FEATURE
// `ids.charging_current` is "Ladestrom" — the feature the user sets, which has no
// reading behind it until a setpoint is actually published. GATING THE BUTTONS ON
// IT MEANT THE BUTTONS WERE ABSENT EXACTLY WHEN THEY WERE NEEDED: on a card where
// nobody had set a current yet, there was nothing to tap to set the first one. The
// buttons therefore follow `state.charging_current`, the reading of register 5066,
// which is there from the first poll on. The tile above them keeps its own, correct
// condition.
// -----------------------------------------------------------------------------

/** Widget key, as declared in the manifest `widgets` field. */
export const CHARGER_WIDGET = 'charger';

/**
 * Action keys carried by the buttons. They are part of the widget contract: a
 * dashboard stores the content the integration sends, so renaming one leaves an
 * existing button doing nothing.
 */
export const ACTION = {
  CURRENT_DOWN: 'current_down',
  CURRENT_UP: 'current_up',
};

/** How many amperes one tap of the current buttons moves. */
export const CURRENT_STEP = 1;

/**
 * The floor of the charging current, in amperes.
 *
 * The manufacturer's app offers 6 A as the lowest setting, and the device's own
 * `1102` answers 0 on the reference unit — a value the wallbox refuses as a
 * setpoint. So 6 A is the floor here, whatever that register claims.
 */
export const MIN_CURRENT = 6;

/**
 * Is a setpoint set?
 *
 * `null` means "no value", and so does `false` — the two arrive from different
 * callers and mean the same thing. Anything else, including 0, is a value that was
 * set and has to be shown as such.
 */
export function hasControl(controlled) {
  return controlled !== null && controlled !== undefined && controlled !== false;
}

/**
 * The label of the current tile, which names the number rather than the concept.
 *
 * "Ladestrom 16 A" answers the question a bar without a number leaves open: is
 * this the value I set, or something the device chose? With no value under our
 * control the label stays plain, because then there is no number to name.
 */
export function currentLabel(t, current) {
  if (!hasControl(current)) return t('current');
  return `${t('current')} ${current} A`;
}

/**
 * The snapshot key the current buttons move, and the one the tile shows.
 *
 * One name in one place: readLimits, the poll plan and the buttons all speak about
 * the same register, and a second spelling of it is a second place to be wrong.
 */
export const CURRENT_READING = 'charging_current';

export function buildChargerContent({
  state,
  device,
  ids = {},
  controlled = null,
  t = (key) => key,
  sentence = () => '',
}) {
  if (!state || !device) {
    return {
      ttl_seconds: 30,
      components: [{ type: 'text', body: t('notConnected') }],
    };
  }

  const components = [];

  // 1. THE SENTENCE. One status row, and the first thing a reader sees.
  components.push({
    type: 'status',
    items: [
      {
        label: t('power'),
        icon: state.charging_state === 1 ? 'zap' : 'battery-charging',
        value: sentence(state),
        color: stateColor(state),
      },
    ],
  });

  // 2. The live power, as a tile bound to its own feature. It follows the
  //    published states, so nothing has to be refreshed here.
  if (ids.power) {
    components.push({
      type: 'value',
      label: t('power'),
      icon: 'zap',
      device_feature: ids.power,
      unit: 'kW',
      color: state.charging_state === 1 ? 'success' : 'neutral',
    });
  }

  // 3. What this session has charged, so the card answers the question the user
  //    actually has: how much went into the car.
  if (ids.session_energy) {
    components.push({
      type: 'value',
      label: t('energy'),
      icon: 'battery',
      device_feature: ids.session_energy,
      unit: 'kWh',
      color: 'neutral',
    });
  }

  // 4. The meter reading, which is the lifetime figure.
  if (ids.meter_reading) {
    components.push({
      type: 'value',
      label: t('meter'),
      icon: 'activity',
      device_feature: ids.meter_reading,
      unit: 'kWh',
      color: 'neutral',
    });
  }

  // 5. WHICH CURRENT IS SET, and the user has to be able to tell.
  //
  //    Two states that look alike and are not:
  //      - a value we set: the heartbeat is running and the wallbox charges with
  //        exactly this current;
  //      - no value from us: the wallbox uses its own setting, which this
  //        integration does not read back and therefore does not guess at.
  //
  //    A register READING is not the same as a value WE SET: the tile is bound to
  //    the feature our own writes publish, and its label names the number.
  if (ids.charging_current) {
    components.push({
      type: 'value',
      label: currentLabel(t, controlled),
      icon: 'plug',
      device_feature: ids.charging_current,
      unit: 'A',
      color: hasControl(controlled) ? 'info' : 'neutral',
    });
  }

  // 6. The control: two buttons that move the charging current one ampere at a
  //    time, inside what the device and its cable allow. There is nothing else to
  //    steer on this device.
  //
  //    Gated on the READING, not on the published feature — see the note at the top
  //    of this file. This is what makes the card usable on a fresh installation.
  if (hasControl(state[CURRENT_READING])) {
    components.push({
      type: 'button',
      label: '− 1 A',
      icon: 'minus',
      style: 'secondary',
      action: { key: ACTION.CURRENT_DOWN, params: { step: CURRENT_STEP } },
    });
    components.push({
      type: 'button',
      label: '+ 1 A',
      icon: 'plus',
      style: 'secondary',
      action: { key: ACTION.CURRENT_UP, params: { step: CURRENT_STEP } },
    });
  }

  return { ttl_seconds: 60, components };
}

/** The colour of the state row: a fault is not a neutral event. */
function stateColor(state) {
  if (state.fault_code) return 'danger';
  if (state.chargepoint_state === 8) return 'danger';
  if (state.charging_state === 1) return 'success';
  if (state.chargepoint_state === 7) return 'warning';
  return 'neutral';
}

/**
 * Work out what a tapped button means, without doing it.
 *
 * The widget returns an intention; the caller applies it, because the caller owns
 * the connection and the heartbeat. Keeping the two apart is what stops a card
 * from being able to write to a device on its own.
 *
 * `step` moves the current from the value the user sees, not from a value
 * remembered somewhere else: two taps in a row then give two different currents.
 *
 * WHAT THE FIELD NAMES ARE, AND WHY THAT IS A DECISION
 * The snapshot holds `charging_current` — register 5066, in AMPERES, scaled by 0.1.
 * This helper therefore returns the number AND the name it carries, so the caller
 * can fold it into the snapshot under the right key. An earlier version returned
 * `{ current }` and expected the caller to know where it goes; that is the kind of
 * implicit contract that produced a card whose power tile read "kW" from a value
 * that was never there.
 *
 * THE CEILING IS OPTIONAL, AND THAT IS DELIBERATE
 * When the caller passes the limits it read from the device, a tap can never leave
 * the range the wallbox accepts. When it does not, the floor still applies and the
 * ceiling is left open — an invented ceiling of 6 A would turn every tap into "set
 * 6 A", which is the failure this signature exists to avoid.
 */
export function chargerAction({
  actionKey,
  params,
  state,
  limits,
  t = (key) => key,
}) {
  switch (actionKey) {
    case ACTION.CURRENT_DOWN:
    case ACTION.CURRENT_UP: {
      const step = Number(params?.step ?? CURRENT_STEP);
      const delta = actionKey === ACTION.CURRENT_UP ? step : -step;
      const known = rawAmps(state?.[CURRENT_READING]);
      const base = Number.isFinite(known) ? known : MIN_CURRENT;
      const min = Math.max(MIN_CURRENT, Number(limits?.min) || MIN_CURRENT);
      const ceiling = Number(limits?.max);
      const max = Number.isFinite(ceiling) ? Math.max(min, ceiling) : Infinity;
      const next = Math.min(max, Math.max(min, Math.round(base + delta)));
      return { key: CURRENT_READING, current: next, toast: t('control', next) };
    }
    default:
      throw new Error(`Unknown widget action: ${actionKey}`);
  }
}

/**
 * A current reading as whole amperes.
 *
 * The device reports register 5066 in tenths of an ampere, so 130 is 13 A and 65 is
 * the 6.5 A a car or a cable may ask for. Two things follow, and both are needed:
 *
 *   - the figure the button starts from has to be rounded to whole amperes, because
 *     a setpoint is written in whole amperes;
 *   - a missing or unusable reading must not be read as 0. `Number(null)` is 0, and
 *     a 0 base would clamp every tap to the 6 A floor while looking perfectly
 *     healthy — that was a real bug in the WattWächter integration.
 */
export function rawAmps(value) {
  const tenths = typeof value === 'object' && value !== null ? value.value : value;
  const number = Number(tenths);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number) / 10;
}
