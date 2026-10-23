// -----------------------------------------------------------------------------
// Scene triggers and scene actions for the wallbox.
//
// WHAT IS WHAT
//   a TRIGGER is an EVENT the integration fires. Keys are forever: a scene
//   stores them.
//   an ACTION is an OPERATION a scene author places in a scene.
//
// THE TWO TRIGGERS WATCH A FLANK, AND WHY THAT MATTERS
// "Wallbox lädt" and "Wallbox beendet" say that something CHANGED. The device's
// charging register is 1 while energy flows, and a scene bound to the value
// rather than to the change would fire on every poll — every 30 seconds, for
// hours. So the integration remembers the last value and fires only on the
// crossing, the same way the WattWächter integration reports a power threshold
// being crossed rather than a power being high.
//
// WHY THE COMPARISON LIVES HERE
// A trigger declared by an integration can only match EQUALITY on its fields:
// there is no operator and no threshold on the Gladys side. "Started" is
// therefore an event the integration derives, not a condition a scene checks.
//
// THE ACTIONS
// `set_charging_current` and `release_charging_current` belong to the heartbeat
// in src/alive.js: setting a current starts it, releasing stops it. A scene that
// only reads values never touches either.
// -----------------------------------------------------------------------------

import { CONTROL, FAILSAFE } from './vestel/registers.js';

/** The trigger keys, as declared in the manifest. */
export const TRIGGER = {
  CHARGING_STARTED: 'charging_started',
  CHARGING_FINISHED: 'charging_finished',
};

/**
 * The events to fire for a change of the charging register.
 *
 * `previous` is what the caller stored from the last call, and it starts as null
 * on purpose: after a restart the integration does not know whether a car was
 * already charging, and firing "started" for a session that began before the
 * restart would be a lie about when it began. The first reading therefore only
 * records the state, and events begin with the second one.
 */
export function chargingEvents({ snapshot, previous }) {
  const now = snapshot?.charging_state === 1 ? 1 : 0;
  if (previous === null || previous === undefined) return { events: [], side: now };
  if (now === previous) return { events: [], side: now };

  if (now === 1) {
    return {
      events: [
        {
          key: TRIGGER.CHARGING_STARTED,
          data: {
            power: snapshot.power ?? null,
            current: readCurrentAmps(snapshot),
            energy: kilowattHours(snapshot.meter_reading, 10),
          },
        },
      ],
      side: now,
    };
  }

  return {
    events: [
      {
        key: TRIGGER.CHARGING_FINISHED,
        data: {
          energy: kilowattHours(snapshot.meter_reading, 10),
          session_energy: kilowattHours(snapshot.session_energy, 1),
          duration: snapshot.session_duration ?? null,
        },
      },
    ],
    side: now,
  };
}

/** The current on L1 in amperes, which is the figure a user recognises. */
export function readCurrentAmps(snapshot) {
  const milli = snapshot?.current_l1;
  return Number.isFinite(milli) ? Math.round(milli) / 1000 : null;
}

/**
 * A raw counter as kilowatt-hours.
 *
 * `divisor` is the device's own step: the meter reading counts 0.1 kWh, the
 * session energy counts watt-hours. One place, so a scene and the interface
 * cannot disagree about the unit of the same number.
 */
export function kilowattHours(raw, divisor = 1) {
  if (!Number.isFinite(raw)) return null;
  return Math.round((raw / divisor / 1000) * 1000) / 1000;
}

/**
 * One handler per declared scene action, keyed as in the manifest.
 *
 * The caller passes the live connection and the heartbeat in, so nothing here
 * reaches for a global: an action runs against the connection that is current at
 * the moment the scene reaches it.
 */
export const SCENE_ACTIONS = {
  /**
   * Set the charging current, and start the heartbeat.
   *
   * The value is clamped to what the EVSE and the cable allow, read from the
   * device. Asking a wallbox for more than its cable accepts is not an error it
   * reports; it is simply a value it quietly ignores.
   */
  async set_charging_current({ client, fields, control }) {
    if (!client) throw new Error('Keine Verbindung zur Wallbox');
    const wanted = Number(fields?.current);
    if (!Number.isFinite(wanted)) throw new Error('Der Ladestrom muss eine Zahl sein');

    const limits = await client.readLimits().catch(() => null);
    const min = limits?.min ?? 6;
    const max = limits?.max ?? 32;
    const current = Math.min(max, Math.max(min, Math.round(wanted)));

    await client.writeRegister(CONTROL.charging_current, current);
    control.set(current);
    return { current };
  },

  /**
   * Release the current and stop the heartbeat.
   *
   * What is written is the FAILSAFE current, not zero: the wallbox has no "no
   * charging" register, and a current of zero is a value it refuses. Handing
   * control back to the failsafe value is what "released" means here, and the
   * heartbeat stopping is what lets it take effect.
   */
  async release_charging_current({ client, control }) {
    if (!client) throw new Error('Keine Verbindung zur Wallbox');
    const failsafe = control.failsafeCurrent();
    await client.writeRegister(CONTROL.charging_current, failsafe);
    control.clear();
    return { current: failsafe };
  },
};

/** The register blocks a scene action may need, re-exported so a test can name them. */
export const REGISTERS = { CONTROL, FAILSAFE };
