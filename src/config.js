// -----------------------------------------------------------------------------
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

export const DEFAULT_CONFIG = {
  host: '',
  modbus_port: 502,
  // The Vestel EVC04 answers on unit id 255, not on the 1 most Modbus devices
  // use. A wrong unit id is not an error the device reports: it simply does not
  // answer.
  unit_id: 255,
  // MILLISECONDS, as Gladys works with: only the values out of
  // DEVICE_POLL_FREQUENCIES (1000, 2000, 10000, 15000, 30000, 60000) are
  // accepted. Half a minute is the default: a charge is a slow process, and the
  // scene triggers still react within half a minute.
  poll_frequency: 30000,
  // The current the wallbox falls back to when the heartbeat stops. The smallest
  // value a car accepts is the safe choice: a released control should mean
  // "charge slowly", not "charge uncontrolled".
  failsafe_current: 6,
  // Seconds after which the wallbox switches to the failsafe current. The
  // heartbeat is written every half of it, never less than every 3 seconds.
  failsafe_timeout: 20,
};

export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    host: String(raw.host ?? DEFAULT_CONFIG.host).trim(),
    modbus_port: Number(raw.modbus_port ?? DEFAULT_CONFIG.modbus_port),
    unit_id: Number(raw.unit_id ?? DEFAULT_CONFIG.unit_id),
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    failsafe_current: Number(raw.failsafe_current ?? DEFAULT_CONFIG.failsafe_current),
    failsafe_timeout: Number(raw.failsafe_timeout ?? DEFAULT_CONFIG.failsafe_timeout),
  };
}
