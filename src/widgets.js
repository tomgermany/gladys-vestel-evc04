// -----------------------------------------------------------------------------
// The dashboard widget "Wallbox".
//
// PORTED FROM THE WATTWAECHTER WIDGET, WHICH RUNS ON A REAL DASHBOARD
// The component grammar below is not invented: `{ ttl_seconds, components }` with
// `value`, `status` and `button` entries is exactly what the WattWächter card
// sends, and what its user sees rendered.
//
// WHAT A WIDGET IS HERE
// A small card on the dashboard. This file builds its CONTENT; the Gladys core
// renders it. No HTML, no CSS, no script: the content is a declarative tree of
// components in a small vocabulary, and the core normalises, bounds and translates
// it. That is why the card looks right in dark mode, on a phone and on a wall
// tablet without us doing anything.
//
// THE HANDLERS ARE NOT HERE
// This file only builds content and works out what a tap means. Gladys asks for the
// content through `onWidgetGet` and reports taps through `onWidgetAction`, and BOTH
// have to be registered in index.js under the manifest's widget key. With no
// `onWidgetAction`, a tap on a button is answered by the SDK's default reply to an
// unhandled message and the button does nothing.
//
// THE SETTINGS ARE READ, NOT IGNORED
// `onWidgetGet` is called with the widget instance's settings, and they reach this
// file as `settings`. The WattWächter reads them to decide which period its card
// shows; the same mechanism decides the STEP of the current buttons here, so two
// copies of the card can step by 1 A and 2 A. A parameter a function accepts and
// then does not look at is what a lint rule exists to catch, and it was right to.
//
// THE BUDGET — why this file counts its components
// A card takes at most 8 components, and among them at most 4 BUTTONS, 6 value
// tiles, 2 texts and 1 status list. Anything past a cap is DROPPED, in content
// order, silently. The sentence plus the current tile plus the two buttons come to
// four of the eight.
//
// WHAT THE CARD SHOWS
//   - the state as ONE sentence, in a status row: "Ich lade aktuell mit 11 kW."
//   - the measured total charging current as a value tile, bound to its own
//     feature, so it follows the history without a refresh being wired here.
//   - two buttons which move the setpoint inside what the device and its cable
//     allow, by the step the widget's settings ask for.
//
// WHY THE TILE IS BOUND TO A FEATURE AND NOT TO A NUMBER
// A tile with `device_feature` carries the external id of a published feature, and
// Gladys reads that feature's own value and history. It therefore stays right by
// itself.
//
// THE BUTTON TARGET COMES FROM THE SNAPSHOT, NOT FROM THE PUBLISHED FEATURE
// Gating the buttons on the published feature meant they were absent exactly when
// they were needed: on a card where nobody had set a current yet, there was nothing
// to tap to set the first one. They therefore follow `state.charging_current`, the
// reading of register 1500, which is there from the first poll on.
//
// WHAT UNIT THE CURRENT IS IN, AND WHY IT IS WRITTEN DOWN HERE
// Register 1500 counts TENTHS of an ampere: 130 is 13 A. The figure is normalised
// in ONE function, `amps()` below, and every caller goes through it. An earlier
// version divided by ten in one place and assumed amperes in another, so every tap
// was clamped to the 6 A floor — a card that looked healthy and could only ever set
// 6 A.
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

/** How many amperes one tap moves when the widget's settings say nothing. */
export const CURRENT_STEP = 1;

/** The step values a widget instance may choose, in amperes. */
export const STEP_CHOICES = [1, 2, 5];

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
 * `null` means "no value", and so does `false`. Anything else, including 0, is a
 * value that was set and has to be shown as such.
 */
export function hasControl(controlled) {
  return controlled !== null && controlled !== undefined && controlled !== false;
}

/**
 * The step one tap of a button moves.
 *
 * WHY IT IS READ FROM THE SETTINGS RATHER THAN FIXED
 * The widget's settings are per INSTANCE, so two cards on two dashboards can move
 * the current by different amounts — the same mechanism the WattWächter uses to
 * let each copy of its card show its own period. A setting that is not offered
 * among STEP_CHOICES, or one that is missing, falls back to the default instead of
 * being trusted: the value comes from a stored dashboard, and a stored dashboard
 * outlives the code that wrote it.
 */
export function stepFromSettings(settings = {}) {
  const step = Number(settings?.step ?? settings?.current_step);
  if (!Number.isFinite(step) || step <= 0) return CURRENT_STEP;
  return STEP_CHOICES.includes(step) ? step : CURRENT_STEP;
}

/**
 * The label of the current tile, which names the number rather than the concept.
 *
 * "Ladestrom 16 A" answers the question a bar without a number leaves open: is
 * this the value I set, or something the device chose?
 */
export function currentLabel(t, current) {
  if (!hasControl(current)) return t('current');
  return `${t('current')} ${current} A`;
}

/**
 * The snapshot key the current buttons move, and the one the tile shows.
 *
 * One name in one place: the poll plan, the device builder and the buttons all
 * speak about the same reading, and a second spelling of it is a second place to
 * be wrong.
 */
export const CURRENT_READING = 'charging_current';

/** The separately measured sum of the three phase currents, in whole amperes on display. */
export const TOTAL_CURRENT_READING = 'total_current';

/**
 * @param {object} ctx
 * @param {object|null} ctx.state the last reading snapshot
 * @param {object|null} ctx.device { name, serial, model, host }
 * @param {object} ctx.ids { charging_current } external id of the published feature
 * @param {number|false|null} ctx.controlled the charging current we have set
 * @param {object} ctx.settings the widget instance settings, see stepFromSettings
 * @param {Function} ctx.t labels, per language
 * @param {Function} ctx.sentence the state as one sentence
 */
export function buildChargerContent({
  state,
  device,
  ids = {},
  controlled = null,
  settings = {},
  t = (key) => key,
  sentence = () => '',
}) {
  if (!state || !device) {
    return {
      ttl_seconds: 30,
      components: [{ type: 'text', body: t('notConnected') }],
    };
  }

  const step = stepFromSettings(settings);
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

  // 2. The measured total current, as a tile bound to its own feature. The sum is
  //    rounded to whole amperes before publication; the control setpoint is separate.
  if (ids.total_current) {
    components.push({
      type: 'value',
      label: t('current_total'),
      icon: 'plug',
      device_feature: ids.total_current,
      unit: 'A',
      color: hasControl(controlled) ? 'info' : 'neutral',
    });
  }

  // 3. The control: two buttons which move the charging current by the step the
  //    widget's settings ask for, inside what the device and its cable allow.
  //
  //    Gated on the READING, not on the published feature — see the note at the top
  //    of this file. This is what makes the card usable on a fresh installation.
  if (hasControl(state[CURRENT_READING])) {
    components.push({
      type: 'button',
      label: `− ${step} A`,
      icon: 'minus',
      style: 'secondary',
      action: { key: ACTION.CURRENT_DOWN, params: { step } },
    });
    components.push({
      type: 'button',
      label: `+ ${step} A`,
      icon: 'plus',
      style: 'secondary',
      action: { key: ACTION.CURRENT_UP, params: { step } },
    });
  }

  return { ttl_seconds: 60, components };
}

/** The colour of the state row: a fault is not a neutral event. */
function stateColor(state) {
  const code =
    typeof state.chargepoint_state === 'object' && state.chargepoint_state !== null
      ? state.chargepoint_state.value
      : state.chargepoint_state;
  const fault =
    state.fault_code && typeof state.fault_code === 'object'
      ? state.fault_code.value
      : state.fault_code;
  if (fault) return 'danger';
  if (code === 8) return 'danger';
  if (state.charging_state === 1) return 'success';
  if (code === 7) return 'warning';
  return 'neutral';
}

/**
 * Work out what a tapped button means, without doing it.
 *
 * The widget returns an intention; the caller applies it, because the caller owns
 * the connection and the heartbeat. Keeping the two apart is what stops a card from
 * being able to write to a device on its own.
 *
 * `step` moves the current from the value the user sees, not from a value
 * remembered somewhere else: two taps in a row then give two different currents. It
 * arrives in the button's own params, which is where the widget instance's setting
 * ends up.
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
      const base = amps(state?.[CURRENT_READING]);
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
 * A current as whole amperes, whatever shape and unit it arrives in.
 *
 * WHAT IT ACCEPTS, AND WHY IT IS LENIENT HERE
 * A snapshot entry (`{ value, word }`) or a bare number; amperes (16) or tenths of
 * an ampere (160). Two callers reach this with two different conventions — the poll
 * plan stores the raw register count, a hand-written reading states amperes — and
 * both are legitimate, so the figure is normalised in one place.
 *
 * THE THRESHOLD IS WHAT KEEPS THE TWO UNITS APART
 * Register 1500 counts tenths of an ampere, so 130 means 13 A; a setpoint is never
 * above 32 A, and a tenths reading never below 60 for a real session. Above 100 the
 * figure is therefore a count of tenths, and at or below 100 it is already amperes.
 *
 * AND A MISSING VALUE IS NOT ZERO
 * `Number(null)` is 0, and a base of 0 would clamp every tap to the 6 A floor while
 * looking perfectly healthy.
 */
export function amps(value) {
  const bare = typeof value === 'object' && value !== null ? value.value : value;
  const number = Number(bare);
  if (!Number.isFinite(number) || number <= 0) return MIN_CURRENT;
  return number > 100 ? Math.round(number) / 10 : Math.round(number);
}
