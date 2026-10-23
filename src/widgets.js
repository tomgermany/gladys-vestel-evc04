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
// from that moment the setpoint holds, and the heartbeat in src/alive.js keeps it
// alive. A card that did not say so would leave the user guessing which of the two
// states is in force — "charges at 6 A because the car asked for it" and "charges
// at 6 A because nobody is controlling it" look identical on the device page.
//
// WHY THERE IS A RELEASE BUTTON AND NOT JUST +/- STEPS
// A setpoint can be set from a scene and released from a scene; if the card could
// only set, the difference would be invisible here. Both surfaces therefore offer
// both, and the button appears only while a setpoint is under control — a button
// that would do nothing is worse than no button.
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
// looks at, then the buttons. A fifth button would simply never appear, which is
// why the release button is conditional.
//
// THE TILES ARE BOUND TO FEATURES, NOT TO NUMBERS
// A tile with `device_feature` carries the external id of a published feature,
// and Gladys reads that feature's own value and history. It therefore stays right
// by itself and needs nothing from here.
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
  RELEASE: 'release',
};

/** How many amperes one tap of the current buttons moves. */
export const CURRENT_STEP = 1;

/** The smallest charging current a vehicle is expected to accept, in amperes. */
export const MIN_CURRENT = 6;

/**
 * Is a setpoint under our control?
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
 * @param {object} ctx
 * @param {object|null} ctx.state the last reading snapshot
 * @param {object|null} ctx.device { name, serial, model, host }
 * @param {object} ctx.ids { power, session_energy, meter_reading, charging_current }
 * @param {number|false|null} ctx.controlled the charging current under our control
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
  //      - no value under our control: the wallbox uses its own setting, which
  //        this integration does not read back and therefore does not guess at.
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
      color: hasControl(controlled) ? 'info' : 'neutral',
    });
  }

  // 6. The control. Two buttons that move the charging current one ampere at a
  //    time, inside what the device and its cable allow.
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

    // 7. The release button, only while a setpoint is under control.
    if (hasControl(controlled)) {
      components.push({
        type: 'button',
        label: t('release'),
        icon: 'x',
        style: 'secondary',
        action: { key: ACTION.RELEASE },
      });
    }
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
  controlled = null,
  limits,
  t = (key) => key,
}) {
  switch (actionKey) {
    case ACTION.CURRENT_DOWN:
    case ACTION.CURRENT_UP: {
      const step = Number(params?.step ?? CURRENT_STEP);
      const delta = actionKey === ACTION.CURRENT_UP ? step : -step;
      const known = Number(state?.charging_current);
      const base = Number.isFinite(known) && known > 0 ? known : MIN_CURRENT;
      const min = Math.max(MIN_CURRENT, Number(limits?.min) || MIN_CURRENT);
      const ceiling = Number(limits?.max);
      const max = Number.isFinite(ceiling) ? Math.max(min, ceiling) : Infinity;
      const next = Math.min(max, Math.max(min, Math.round(base + delta)));
      return { current: next, toast: t('control', next) };
    }
    case ACTION.RELEASE: {
      if (!hasControl(controlled)) {
        throw new Error('No charging current is under control');
      }
      return { release: true, toast: t('releasing') };
    }
    default:
      throw new Error(`Unknown widget action: ${actionKey}`);
  }
}
