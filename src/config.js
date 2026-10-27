// Integration configuration.
//
// Filled in by the user in Gladys, from the `config_schema` of
// `gladys-assistant-integration.json`. The SDK fetches it (`gladys.getConfig()`)
// and notifies every change through `gladys.onConfigUpdated()`.
//
// DEFAULTS MUST MATCH THE MANIFEST, EXACTLY
// `normalizeConfig()` runs at startup and on every change, and whatever it fills
// in is what the rest of the code works with. A default that disagrees with the
// manifest is therefore not cosmetic: it is the value the integration really
// uses, and the user never sees it, because the form shows only what the
// manifest declares.
//
// test/manifest.test.js compares the two files, which is how a mismatch is meant
// to be caught before a release rather than after one.
// -----------------------------------------------------------------------------

const posInt = (v, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const DEFAULT_CONFIG = {
  host: '',
  modbus_port: 502,
  // The Vestel EVC04 answers on unit id 255, not on the 1 most Modbus devices
  // use. A wrong unit id is not an error the device reports: it simply does not
  // answer.
  unit_id: 255,
  // The user chooses a realistic interval in minutes. The internal frequency is
  // converted to milliseconds for the elapsed-time check in index.js.
  poll_interval_minutes: 5,
  poll_frequency: 5 * 60 * 1000,
  // The current the wallbox falls back to when the heartbeat stops (register 2000).
  // 16 A matches the installer limit of this installation (register 1104). It must
  // never exceed that limit. The register is persistent on the wallbox: a low value
  // here keeps the wallbox at that current after every restart of Gladys.
  failsafe_current: 16,
 // Written to register 2002 only when a user/scene/widget explicitly changes
  // the setpoint. If the heartbeat is then missed, the wallbox falls back to the
  // failsafe current; the heartbeat period is half this timeout, at least 3 s.
  failsafe_timeout: 20,
};

export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    host: String(raw.host ?? DEFAULT_CONFIG.host).trim(),
    modbus_port: Number(raw.modbus_port ?? DEFAULT_CONFIG.modbus_port),
    unit_id: Number(raw.unit_id ?? DEFAULT_CONFIG.unit_id),
    // Ignore the old millisecond-based setting if it is still stored by Gladys.
    // The new field is explicit and offers only 1, 5, 15, 30 or 60 minutes.
    poll_interval_minutes: [1, 5, 15, 30, 60].includes(
      Number(raw.poll_interval_minutes ?? DEFAULT_CONFIG.poll_interval_minutes),
    )
      ? Number(raw.poll_interval_minutes ?? DEFAULT_CONFIG.poll_interval_minutes)
      : DEFAULT_CONFIG.poll_interval_minutes,
    poll_frequency:
      ([1, 5, 15, 30, 60].includes(Number(raw.poll_interval_minutes))
        ? Number(raw.poll_interval_minutes)
        : DEFAULT_CONFIG.poll_interval_minutes) * 60 * 1000,
    failsafe_current: posInt(raw.failsafe_current, DEFAULT_CONFIG.failsafe_current),
    failsafe_timeout: Math.max(6, posInt(raw.failsafe_timeout, DEFAULT_CONFIG.failsafe_timeout)),
  };
}
