// -----------------------------------------------------------------------------
// The register map of the Vestel EVC04, as ONE object.
//
// WHY EVERY ADDRESS LIVES HERE AND NOWHERE ELSE
// Two kinds of mistake cost days on a project like this: an address that is off by
// one, and an address that is right on paper and wrong on the wire. Keeping them
// together means a correction is a one-line edit in one file.
//
// THE ADDRESS QUESTION, AND HOW TO SETTLE IT AT THE DEVICE
// The manufacturer's table prints ranges like "Serial Number [100,124]" and single
// addresses like `1008`. Two readings are possible:
//
//   A)  the brackets hold BYTE offsets, so a range of 25 bytes is 13 registers
//       and the serial number starts at register 50. This is the reading used
//       below;
//   B)  the numbers are already REGISTERS, so the serial number starts at 100.
//
// The device answers this in one attempt: the connection test reads the serial
// number with the configured base and reports what came back. Readable text means
// the base is right; `Modbus exception 2` (illegal data address) means it is not,
// and `ADDRESS_BASE` below is the one line to change.
//
// WHAT MAY BE WRITTEN, AND WHAT MAY ONLY BE READ
// Exactly two registers are written, and both are charging control rather than
// configuration:
//
//   CONTROL.charging_current (5004)   the setpoint
//   FAILSAFE.alive (6000)             the heartbeat that keeps the setpoint
//
// Everything else is READ. The limit registers are the installer's figures and
// this integration respects them; the failsafe registers are read back but never
// set. What the rule buys is the answer to a plain question: what can someone who
// does not know this device do from Gladys? They can change how much current
// flows, which is the feature. They cannot reconfigure the wallbox.
//
// TWO CHARACTERS PER REGISTER, SPACE PADDED
// A string block holds two ASCII characters per 16-bit register, so a 25-byte
// field is 13 registers and a 5-byte field is 3.
//
// NO SCALE FACTORS ON THIS MAP
// The specification states every unit outright — mA, V, W, 0.1 kWh, Wh, A — so
// nothing here needs a factor register. That is the main difference from a SunSpec
// device, and the reason this map is much shorter than the WattWächter's.
// -----------------------------------------------------------------------------

/**
 * Which reading of the address table applies.
 *
 *   'byte-ranges'  bracket ranges are byte offsets, divided by two for a register.
 *                  The default, and what the table looks like.
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
 * The serial number is the one that matters: it is the device's stable identity in
 * Gladys, so a wallbox that gets a new IP address from the router keeps its history
 * and its scenes.
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
 * These are the figures the installer set on the device, and they answer "how much
 * may I ask for", not "how much do I want". A setpoint above `evse_max_current` is
 * not an error the wallbox reports — it charges at its own maximum while Gladys
 * would report the number it was asked for, which is why every setpoint is clamped
 * against these values rather than against a constant in the code.
 *
 * `session_max_current` is deliberately not part of the ceiling: it describes the
 * session that is running, not what may be asked for.
 */
export const READ_ONLY = {
  evse_min_current: 1102,
  evse_max_current: 1104,
  cable_max_current: 1106,
};

/** The session registers, read for the triggers and the card. */
export const SESSION = {
  max_current: 1100,
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

/** Where a controlled charging current is written. */
export const CONTROL = {
  charging_current: 5004,
};

/**
 * The smallest and the largest charging current used when the device does not
 * answer its own limit registers at all.
 *
 * THE CEILING IS NOT A GUESS ABOUT ANY PARTICULAR WALLBOX
 * It is the smallest figure that makes sense for a home charge point. A ceiling that
 * is too high is not refused by the device — the wallbox charges at its own maximum
 * while Gladys reports what it was asked for. So the fallback stays low on purpose,
 * and the real figure is normally read from 1104 and 1106.
 */
export const DEFAULT_MIN_CURRENT = 6;
export const DEFAULT_MAX_CURRENT = 16;

/** The shortest alive period the device accepts, in seconds. */
export const MIN_ALIVE_PERIOD_S = 3;

/**
 * The alive period for a given failsafe timeout: half of it, never below 3 s.
 *
 * Half is what the specification prescribes. The floor exists because a timeout
 * configured to 4 seconds would otherwise ask for a 2-second beat, and the device
 * refuses to be driven that fast.
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
 * Everything read on a poll, with how to read it.
 *
 * `kind` is what the reader does with the address:
 *   'uint16'  one register, unsigned
 *   'acc32'   two registers, high word first, unsigned
 *   'state'   one register, looked up in a named table
 * A reading the device does not provide is left OUT of the snapshot rather than
 * published as a zero: a wrong value in the history is worse than a missing one.
 */
export const POLL_PLAN = [
  { key: 'chargepoint_state', kind: 'state', address: STATE.chargepoint, table: CHARGEPOINT_STATE },
  { key: 'charging_state', kind: 'uint16', address: STATE.charging },
  { key: 'equipment_state', kind: 'state', address: STATE.equipment, table: EQUIPMENT_STATE },
  { key: 'cable_state', kind: 'state', address: STATE.cable, table: CABLE_STATE },
  { key: 'fault_code', kind: 'acc32', address: STATE.fault.address },
  { key: 'current_l1', kind: 'uint16', address: METER.current_l1, unit: 'mA' },
  { key: 'current_l2', kind: 'uint16', address: METER.current_l2, unit: 'mA' },
  { key: 'current_l3', kind: 'uint16', address: METER.current_l3, unit: 'mA' },
  { key: 'voltage_l1', kind: 'uint16', address: METER.voltage_l1, unit: 'V' },
  { key: 'voltage_l2', kind: 'uint16', address: METER.voltage_l2, unit: 'V' },
  { key: 'voltage_l3', kind: 'uint16', address: METER.voltage_l3, unit: 'V' },
  { key: 'power', kind: 'acc32', address: METER.power.address, unit: 'W' },
  { key: 'power_l1', kind: 'acc32', address: METER.power_l1.address, unit: 'W' },
  { key: 'power_l2', kind: 'acc32', address: METER.power_l2.address, unit: 'W' },
  { key: 'power_l3', kind: 'acc32', address: METER.power_l3.address, unit: 'W' },
  { key: 'meter_reading', kind: 'acc32', address: METER.meter_reading.address, unit: '0.1kWh' },
  { key: 'session_energy', kind: 'acc32', address: SESSION.energy.address, unit: 'Wh' },
  { key: 'session_duration', kind: 'acc32', address: SESSION.duration.address, unit: 's' },
  { key: 'session_max_current', kind: 'uint16', address: SESSION.max_current, unit: 'A' },
  { key: 'evse_min_current', kind: 'uint16', address: READ_ONLY.evse_min_current, unit: 'A' },
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
