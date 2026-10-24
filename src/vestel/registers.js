// -----------------------------------------------------------------------------
// The register map of the Vestel EVC04, as ONE object.
//
// WHY EVERY ADDRESS LIVES HERE AND NOWHERE ELSE
// Two kinds of mistake cost days on a project like this: an address that is off by
// one, and an address that is right on paper and wrong on the wire. Keeping them
// together means a correction is a one-line edit in one file.
//
// CHECKED AGAINST THE MANUFACTURER'S TABLE (v1.5)
// The whole map below was read back against the specification page by page. What
// that confirmed, and what it corrected:
//
//   - port 502, unit id 255, and EXACTLY ONE master at a time (stated twice);
//   - `Charging Current` (5004) is uint16 in AMPERES — this is the only register
//     that steers a charge;
//   - `EVSE Min Current` (1102), `EVSE Max Current` (1104), `Cable Max Current`
//     (1106) and `Session Max Current` (1100) are uint16 in AMPERES, not in
//     milliamperes;
//   - spec v1.4 changed those four units to A, which is why an older reading of
//     this table shows different numbers;
//   - `EVSE Fault Code` (1006) is uint32 since v1.3, so it spans two registers;
//   - there is NO start and NO stop register. The device has no such command: a
//     charge begins when the vehicle accepts the current and ends when it does.
//     What can be steered is how much current is allowed, and that is all this
//     integration steers.
//
// THE STRING BLOCK
// The table prints `Serial Number [100,124]` and similar ranges. Read as BYTE
// offsets that is 13 registers starting at 50, and the device answered readable
// text on the first attempt with that reading — so `ADDRESS_BASE` stays as it is.
//
// WHAT MAY BE WRITTEN, AND WHAT MAY ONLY BE READ
// Exactly two registers are written, and both belong to the charge:
//
//   CONTROL.charging_current (5004)   the current the vehicle may draw
//   FAILSAFE.alive (6000)             the heartbeat that keeps it in force
//
// Everything else is READ. The limit registers are the installer's figures and
// this integration respects them; the failsafe registers are read back but never
// set. What the rule buys is the answer to a plain question: what can someone who
// does not know this device do from Gladys? They can change how much current
// flows, which is the feature. They cannot reconfigure the wallbox.
//
// NO SCALE FACTORS ON THIS MAP
// The specification states every unit outright — mA, V, W, 0.1 kWh, Wh, A — so
// nothing here needs a factor register. That is the main difference from a SunSpec
// device, and the reason this map is much shorter than the WattWächter's.
//
// THREE CURRENTS, AND WHY CONFUSING TWO OF THEM IS THE EASY MISTAKE
// This device names three different currents, and two of them share the printed
// name `Charging Current`. They are not interchangeable:
//
//   5004  `Charging Current`, uint16, AMPERES, READ/WRITE.
//         The SETPOINT: what the vehicle is allowed to draw. Written, never read
//         into the snapshot.
//
//   1008  `Current L1`, uint16, MILLIAMPERES, READ ONLY.
//         The MEASUREMENT: what is really flowing on phase 1. 16000 means 16 A.
//
//   1500  `Charging Current`, uint16, TENTHS OF AN AMPERE, READ ONLY.
//         The report of the running session: 130 means 13 A. This is the number a
//         user compares a setpoint against, because it is the figure the wallbox
//         itself believes it is delivering.
//
// The poll plan reads 1008 and 1500; only 5004 is written. An earlier version read
// 5066 for the reported current, which is not an address of this device at all.
//
// CHECKED AGAINST THE REVISION LIST
// The specification's own revision history was read for the registers that changed
// meaning, because a table is only as good as the version it describes:
//
//   v1.2  ChargePointState, the alive register, charging state, equipment state;
//   v1.3  `EVSE Fault Code` (1006) widened uint16 -> uint32, so it spans two
//         registers — a one-register read of it returns half a number;
//   v1.4  `Session Max Current` (1100), `EVSE Min Current` (1102), `EVSE Max
//         Current` (1104) and `Cable Max Current` (1106) changed UNIT to amperes.
//
// WHAT THE TABLE PRINTS TWICE, AND WHAT THAT COSTS
// `Charging Current` appears twice in the v1.5 table: once as the writable setpoint
// at 5004, and once as the tenths-of-an-ampere report at 1500. Both are real
// registers. The second one is reached through `SESSION`, and the shared name is
// exactly why both are spelled out above rather than left to the reader.
// -----------------------------------------------------------------------------

/**
 * Which reading of the address table applies.
 *
 *   'byte-ranges'  bracket ranges are byte offsets, divided by two for a register.
 *                  The default, and CONFIRMED against the device: the serial number
 *                  came back as readable text on the first attempt.
 *   'registers'    every printed number is already a register address.
 *
 * Only the string blocks in IDENTITY are affected: the measurement and control
 * addresses are single registers and are used as printed under either reading.
 */
export const ADDRESS_BASE = 'byte-ranges';

/** Two characters of a string block per register. */
export const CHARS_PER_REGISTER = 2;

/**
 * A printed byte offset as a register address, under the current reading.
 * The string block counts are derived from the same ranges, so a change of reading
 * cannot leave a count that disagrees with its address.
 */
export function asRegister(byteOffset) {
  return ADDRESS_BASE === 'byte-ranges' ? Math.floor(byteOffset / CHARS_PER_REGISTER) : byteOffset;
}

/** A byte range as the register count it occupies. */
export function asRegisterCount(from, to) {
  const bytes = to - from + 1;
  const registers = Math.ceil(bytes / CHARS_PER_REGISTER);
  return ADDRESS_BASE === 'byte-ranges' ? registers : bytes;
}

const block = (from, to) => ({
  from,
  to,
  address: asRegister(from),
  count: asRegisterCount(from, to),
});

/**
 * The identity block: strings, read once after connecting.
 *
 * Each field is read on its own, so a single refused register costs one field
 * instead of every field after it — the strings are the part most likely to differ
 * between firmware families.
 */
export const IDENTITY = {
  serial: block(100, 124),
  chargepointId: block(130, 179),
  brand: block(190, 199),
  model: block(210, 214),
  firmware: block(230, 279),
};

/**
 * Day and time as the device keeps them, packed as `yymmdd` and `hhmmss` into a
 * uint32 each. Read for the device clock, not for scheduling: a schedule belongs in
 * Gladys, not inside a wallbox.
 */
export const CLOCK = {
  date: { address: 290, count: 2 },
  time: { address: 294, count: 2 },
};

/** One register, `uint16`: the number of phases, 0 = 1-phase, 1 = 3-phase. */
export const PHASES = 404;

/**
 * The state registers, read on every poll.
 *
 * `chargepoint` and `charging` are the two that matter most: the first is what the
 * wallbox is doing, the second is whether energy is flowing right now. The
 * transition of the second is what the two scene triggers fire on.
 */
export const STATE = {
  chargepoint: 1000,
  charging: 1001,
  equipment: 1002,
  cable: 1004,
  // The fault code was widened from uint16 to uint32 in specification v1.3, which
  // is why it occupies two registers here.
  fault: { address: 1006, count: 2 },
};

/**
 * The live electrical readings.
 *
 * Units are the device's own: mA for current, V for voltage, W for power. The
 * conversion into the units Gladys stores happens once, in the device builder, so a
 * scene and the interface can never disagree about the unit of the same number.
 */
export const METER = {
  current_l1: 1008,
  current_l2: 1010,
  current_l3: 1012,
  voltage_l1: 1014,
  voltage_l2: 1016,
  voltage_l3: 1018,
  power: { address: 1020, count: 2 },
  power_l1: { address: 1024, count: 2 },
  power_l2: { address: 1028, count: 2 },
  power_l3: { address: 1032, count: 2 },
  // Meter reading in 0.1 kWh: divided by ten on the way in, so what reaches Gladys
  // is the kilowatt-hour figure the bill uses.
  meter_reading: { address: 1036, count: 2 },
};

/**
 * The limits, READ AND NEVER WRITTEN.
 *
 * Amperes, per specification v1.4. `evse_max_current` is the figure the installer
 * set on the device, and a setpoint above it is not refused — the wallbox simply
 * charges at its own maximum while Gladys would report the number it was asked for.
 * So every setpoint is clamped against these values.
 *
 * `session_max_current` belongs to the ceiling as well: it is the maximum of the
 * session that is running, and a vehicle may ask for less than the device allows.
 * Taking the smallest of the three is what keeps the number Gladys reports the
 * number that is really in force.
 */
export const READ_ONLY = {
  evse_min_current: 1102,
  evse_max_current: 1104,
  cable_max_current: 1106,
  session_max_current: 1100,
};

/**
 * The session registers, read for the triggers and the card.
 *
 * `current` is the reported current of the running session, in TENTHS OF AN AMPERE:
 * 130 is 13 A. It is NOT the setpoint — that is `CONTROL.charging_current` (5004),
 * in amperes. It sits between the energy and the duration because that is where the
 * manufacturer's table prints it, and a block read out of order is how the wrong
 * register gets documented for the next person.
 */
export const SESSION = {
  max_current: 1100,
  current: 1500,
  energy: { address: 1502, count: 2 }, // Wh
  start_time: { address: 1504, count: 2 },
  duration: { address: 1508, count: 2 }, // s
  end_time: { address: 1512, count: 2 },
};

/**
 * The failsafe registers. READ/WRITE on the device, READ ONLY here.
 *
 * The specification calls them R/W, and so the integration could set them — but a
 * failsafe value is device configuration, and it is not something Gladys has any
 * business changing. So they are read back and shown, and never written.
 *
 * `alive` is the one exception, and it is not configuration: the master writes 1,
 * the wallbox writes 0 back, and it checks the register every `timeout / 2`
 * seconds. An unanswered alive register means "the master is gone", and the wallbox
 * falls back to `current`. The period cannot go below 3 seconds.
 */
export const FAILSAFE = {
  current: 2000,
  timeout: 2002,
  alive: 6000,
};

/**
 * Where the charging current is written.
 *
 * `Dynamic charging current`, uint16, AMPERES. This is the ONLY register that
 * steers a charge — the device has no start and no stop command.
 */
export const CONTROL = {
  charging_current: 5004,
};

/**
 * The smallest and the largest charging current this integration will use.
 *
 * THE FLOOR IS 6 A BECAUSE THE MANUFACTURER'S APP SAYS SO
 * The device reports its own minimum in `1102`, and on the reference device that
 * register answers 0 — a value the wallbox would refuse as a setpoint and which no
 * vehicle would accept. The app that ships with the device offers 6 A as the
 * lowest setting, so 6 A is the floor here, whatever the register claims.
 *
 * THE CEILING IS A FALLBACK, NOT A CLAIM
 * It is used only when the device does not answer its limit registers at all. A
 * ceiling that is too high is not refused by the device — it charges at its own
 * maximum while Gladys reports what it was asked for.
 */
export const DEFAULT_MIN_CURRENT = 6;
export const DEFAULT_MAX_CURRENT = 16;

/** The shortest alive period the device accepts, in seconds. */
export const MIN_ALIVE_PERIOD_S = 3;

/**
 * The alive period for a given failsafe timeout: half of it, never below 3 s.
 *
 * Half is what the specification prescribes, and the default timeout is 20 s — a
 * beat every 10 s. The floor exists because a timeout configured to 4 seconds
 * would otherwise ask for a 2-second beat, and the device refuses to be driven
 * that fast.
 */
export function alivePeriodMs(failsafeTimeoutS) {
  const seconds = Math.max(MIN_ALIVE_PERIOD_S, Number(failsafeTimeoutS) / 2 || 0);
  return Math.round(seconds * 1000);
}

/** The chargepoint states, as the specification lists them. */
export const CHARGEPOINT_STATE = {
  0: 'available',
  1: 'preparing',
  2: 'charging',
  3: 'suspended_evse',
  4: 'suspended_ev',
  5: 'finishing',
  6: 'reserved',
  7: 'unavailable',
  8: 'faulted',
};

/** The cable states, as the specification lists them. */
export const CABLE_STATE = {
  0: 'unplugged',
  1: 'plugged',
  2: 'vehicle',
  3: 'locked',
};

/** The equipment states, as the specification lists them. */
export const EQUIPMENT_STATE = {
  0: 'initializing',
  1: 'running',
  2: 'fault',
  3: 'disabled',
  4: 'updating',
};

/**
 * The reported charging current as whole amperes.
 *
 * Register 1500 counts TENTHS of an ampere, so 130 is 13 A. The device also reports
 * 65 for the 6.5 A a car or a cable may ask for, which is why the raw reading stays
 * raw in the snapshot and the rounding happens where a whole ampere is required —
 * see `rawAmps()` in src/widgets.js.
 *
 * A reading of 0 means "no session", not "zero amperes are allowed": a setpoint is
 * a whole number of amperes, so a base of 0 would clamp every tap to the 6 A floor
 * while looking perfectly healthy.
 */
export function sessionAmps(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw / 10;
}

/**
 * Everything read on a poll, with how to read it.
 *
 * `kind` is what the reader does with the address:
 *   'uint16'  one register, unsigned
 *   'acc32'   two registers, high word first, unsigned
 *   'state'   one register, kept as `{ value, word }` — see src/vestel/client.js
 * A reading the device does not provide is left OUT of the snapshot rather than
 * published as a zero: a wrong value in the history is worse than a missing one.
 *
 * WHY A STATE KEEPS ITS NUMBER AND ITS WORD
 * The number is what a feature is published with; the word is what the card's
 * sentence is built from. Both come from the table beside the address, so neither is
 * derived from the other by guessing.
 *
 * WHY `charging_current` IS IN THIS PLAN
 * It is the ONE feature this integration steers, and a controlled value whose
 * reading is never taken is a slider that shows whatever was last asked for. Reading
 * register 1500 gives the card a number the wallbox stands behind, and it is what the
 * two dashboard buttons step from. Without this row the key was absent from every
 * snapshot, the buttons had nothing to start from, and every tap fell back to the
 * 6 A floor. That was a real failure, not a cosmetic one.
 */
export const POLL_PLAN = [
  { key: 'chargepoint_state', kind: 'state', address: STATE.chargepoint, table: CHARGEPOINT_STATE },
  { key: 'charging_state', kind: 'uint16', address: STATE.charging },
  { key: 'equipment_state', kind: 'state', address: STATE.equipment, table: EQUIPMENT_STATE },
  { key: 'cable_state', kind: 'state', address: STATE.cable, table: CABLE_STATE },
  { key: 'charging_current', kind: 'uint16', address: SESSION.current, unit: '0.1A' },
  { key: 'current_l1', kind: 'uint16', address: METER.current_l1, unit: 'mA' },
  { key: 'current_l2', kind: 'uint16', address: METER.current_l2, unit: 'mA' },
  { key: 'current_l3', kind: 'uint16', address: METER.current_l3, unit: 'mA' },
  { key: 'voltage_l1', kind: 'uint16', address: METER.voltage_l1, unit: 'V' },
  { key: 'voltage_l2', kind: 'uint16', address: METER.voltage_l2, unit: 'V' },
  { key: 'voltage_l3', kind: 'uint16', address: METER.voltage_l3, unit: 'V' },
  { key: 'power', kind: 'acc32', address: METER.power.address, unit: 'W' },
  { key: 'meter_reading', kind: 'acc32', address: METER.meter_reading.address, unit: '0.1kWh' },
  { key: 'session_energy', kind: 'acc32', address: SESSION.energy.address, unit: 'Wh' },
  { key: 'session_duration', kind: 'acc32', address: SESSION.duration.address, unit: 's' },
  { key: 'evse_max_current', kind: 'uint16', address: READ_ONLY.evse_max_current, unit: 'A' },
  { key: 'cable_max_current', kind: 'uint16', address: READ_ONLY.cable_max_current, unit: 'A' },
];

/**
 * The register keys the whole integration agrees on.
 *
 * Treated as permanent: they are the suffix of the feature external ids, and Gladys
 * stores the history, the scenes and the dashboards against those.
 */
export const KEY = {
  CHARGE_STATE: 'charge_state',
  CABLE_STATE: 'cable_state',
  POWER: 'power',
  METER_READING: 'meter_reading',
  SESSION_ENERGY: 'session_energy',
  CHARGING_CURRENT: 'charging_current',
};
