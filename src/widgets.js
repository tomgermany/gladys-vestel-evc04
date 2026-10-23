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
// WHY THE CONTROL IS SHOWN AT ALL
// Setting a charging current puts the wallbox under this integration's control:
// from that moment the failsafe value no longer applies, and the heartbeat in
// src/alive.js keeps the value alive. A card that did not say so would leave the
// user guessing which of the two states is in force — "charges at 6 A because
// the car asked for it" and "charges at 6 A because nothing controls it any
// more" look identical on the device page.
//
// WHY THERE IS NO `settings` PARAMETER
// There is one wallbox, and the card shows it. A per-instance setting would only
// exist to choose between several devices, and this integration publishes one.
// Adding a parameter nobody reads is how a lint rule gets silenced instead of
// obeyed.
//
// THE BUDGET — why the order below is a decision
// A card takes at most 8 components, and among them at most 4 BUTTONS, 6 value
// tiles, 2 texts and 1 status list. Anything past a cap is DROPPED, in content
// order, silently. So the sentence comes first, then the values a user actually
// looks at, then the buttons. A fifth button would simply never appear.
//
// THE TILES ARE BOUND TO FEATURES, NOT TO NUMBERS
// A tile with `device_feature` carries the external id of a published feature,
// and Gladys reads that feature's own value and history. It therefore stays
// right by itself and needs nothing from here.
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

/** The smallest charging current a vehicle is expected to accept, in amperes. */
export const MIN_CURRENT = 6;

/**
 * The label of the current tile, which names the number rather than the concept.
 *
 * "Ladestrom 16 A" answers the question a bar without a number leaves open: is
 * this the value I set, or something the device chose? With no value under our
 * control the label stays plain, because then there is no number to name.
 */
export function currentLabel(t, current) {
  if (current === null || current === undefined) return t('current');
  return `${t('current')} ${current} A`;
}

/**
 * @param {object} ctx
 * @param {object|null} ctx.state the last reading snapshot
 * @param {object|null} ctx.device { name, serial, model, host }
 * @param {object} ctx.ids { power, session_energy, meter_reading, charging_current }
 * @param {number|null} ctx.controlled the charging current under our control, or null
 * @param {Function} ctx.t labels, per language
 * @param {Function} ctx.sentence state as one sentence, per language
 */
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
        icon: state.chargepoint_state === 'charging' ? 'zap' : 'battery-charging',
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
      color: state.chargepoint_state === 'charging' ? 'success' : 'neutral',
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

  // 5. WHICH CURRENT IS IN FORCE, and the user has to be able to tell.
  //
  //    Two states that look alike and are not:
  //      - a value under our control: the heartbeat is running and the wallbox
  //        charges with exactly this current;
  //      - no value under our control: the wallbox uses its own failsafe value,
  //        which this integration does not read back from the device and
  //        therefore does not guess at.
  //
  //    A register READING is not the same as a value WE SET: the register holds
  //    whatever was written last, by anyone. So the tile is bound to the feature
  //    our own writes publish, and its label names the number.
  if (ids.charging_current) {
    components.push({
      type: 'value',
      label: currentLabel(t, controlled),
      icon: 'plug',
      device_feature: ids.charging_current,
      unit: 'A',
      color: controlled === null ? 'neutral' : 'info',
    });
  }

  // 6. The control: two buttons that move the charging current one ampere at a
  //    time, inside what the cable and the EVSE allow.
  if (ids.charging_current) {
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
  if (state.chargepoint_state === 'faulted') return 'danger';
  if (state.chargepoint_state === 'charging') return 'success';
  if (state.chargepoint_state === 'unavailable') return 'warning';
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
 */
export function chargerAction({ actionKey, params, state, t = (key) => key }) {
  switch (actionKey) {
    case ACTION.CURRENT_DOWN:
    case ACTION.CURRENT_UP: {
      const step = Number(params?.step ?? CURRENT_STEP);
      const delta = actionKey === ACTION.CURRENT_UP ? step : -step;
      const known = Number(state?.charging_current);
      const base = Number.isFinite(known) && known > 0 ? known : Number(state?.evse_min_current) || MIN_CURRENT;
      const next = Math.max(MIN_CURRENT, Math.round(base + delta));
      return { current: next, toast: t('control', next) };
    }
    default:
      throw new Error(`Unknown widget action: ${actionKey}`);
  }
}
