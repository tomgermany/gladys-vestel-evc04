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
// WHY THERE IS NO "START" AND NO "STOP" ACTION
// The device has neither. The manufacturer's table lists no start and no stop
// register: a charge begins when the vehicle accepts the current, and ends when
// the vehicle stops drawing it. What CAN be steered is how much current the
// vehicle may draw, and that is the single action here.
//
// A RELEASED SETPOINT IS NOT A THING EITHER
// An earlier version had a second action that "handed control back". It did not:
// the wallbox has no such state, and the only thing it can do is have a value in
// 5004. Whoever wants a different current sets a different current.
//
// WHAT MAY BE WRITTEN, AND WHY THAT IS A LIST OF ONE
// The charging current, and nothing else. Setting it overrides what the wallbox
// would do on its own, and the heartbeat in src/alive.js is what keeps it in
// force. Nothing here can change how the wallbox is configured.
// -----------------------------------------------------------------------------



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
   * Set the charging current, and keep the heartbeat running.
   *
   * THE VALUE IS CLAMPED, AND WHY THAT IS NOT OPTIONAL
   * Asking for more than the device accepts is not an error it reports — it simply
   * charges at its own maximum — so without the clamp a scene would report 16 A
   * while the car draws 13. The floor of 6 A comes from the manufacturer's app, not
   * from register 1102: on the reference device that register answers 0, which is a
   * setpoint the wallbox refuses.
   */
  async set_charging_current({ client, fields, control, applySetpoint }) {
    if (!client) throw new Error('Keine Verbindung zur Wallbox');
    const wanted = Number(fields?.current);
    if (!Number.isFinite(wanted)) throw new Error('Der Ladestrom muss eine Zahl sein');

    const limits = client.getLimits();
    const current = Math.min(limits.max, Math.max(limits.min, Math.round(wanted)));

    if (applySetpoint) {
      await applySetpoint(client, current);
    } else {
      // Compatibility for isolated unit tests/callers; the integration supplies
      // applySetpoint so it can initialize failsafe registers before taking control.
      const { CONTROL } = await import('./vestel/registers.js');
      await client.writeRegister(CONTROL.charging_current, current);
      control.set(current);
    }
    return { current };
  },
};
