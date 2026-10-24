// -----------------------------------------------------------------------------
// Modbus TCP protocol for the Vestel EVC04.
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
// It speaks the protocol: it builds a request, reads an answer, and turns
// registers into numbers. The register map of the DEVICE lives next to it in
// `registers.js`, because a map is documentation and this is machinery.
//
// IT HAS NO DEPENDENCY ON THE GLADYS SDK, which is why `npm test` covers it
// without a wallbox and in milliseconds.
//
// FUNCTION CODES
//  0x03  read holding registers      the whole readable map
//  0x06  write single register       5004 (charging current), 6000 (alive)
//  0x10  write multiple registers    nothing here yet, but the frame builder is
//                                    the same shape, so it is included
// The EVC04 specification lists the readable map as "R" and the writable
// registers as "R/W"; everything this integration writes is a single register.
//
// WHY THE ANSWER IS CHECKED SO HARD
// A Modbus master that trusts its answer writes nonsense into the user's
// history and never finds out. Three things are therefore verified before a
// value is used: the length of the frame, the exception bit, and the byte count
// the device claims to have sent. The exception path carries the register that
// was asked for, because "illegal data address" is only actionable when the log
// says which address was asked.
//
// PORTED FROM THE WATTWÄCHTER INTEGRATION, AND WHAT DIFFERS
// The frame handling is unchanged. The SunSpec parts of that file are gone: the
// EVC04 is not a SunSpec device. Nothing on this map carries a scale factor —
// the specification states every unit outright (mA, V, W, 0.1 kWh, Wh, A) — so
// the scaled-int and float32 register paths have no counterpart here and were
// deliberately left out rather than carried along.
// -----------------------------------------------------------------------------

import { ModbusSocket, DEFAULT_UNIT_ID } from './transport.js';

/** 0x03 — read holding registers. */
export const FUNC_READ = 0x03;
/** 0x06 — write a single register. */
export const FUNC_WRITE_ONE = 0x06;

/** A signed 16-bit register holding this value means "not available". */
export const NOT_AVAILABLE = -32768;

export class ModbusError extends Error {}

/**
 * Build a 12-byte Modbus TCP read request (function code 0x03).
 *
 * The address goes on the wire exactly as it is given: this file applies no
 * offset. Whether the addresses in the manufacturer's table are the ones to
 * send is a question for the device, not for the protocol — see the note in
 * registers.js, where the answer is kept in one place.
 */
export function buildReadRequest(address, count, unitId = DEFAULT_UNIT_ID) {
  const frame = new Uint8Array(12);
  const view = new DataView(frame.buffer);
  view.setUint16(0, 0); // transaction id
  view.setUint16(2, 0); // protocol id
  view.setUint16(4, 6); // length: unit + function + 4 payload bytes
  frame[6] = unitId;
  frame[7] = FUNC_READ;
  view.setUint16(8, address);
  view.setUint16(10, count);
  return frame;
}

/**
 * Build a 12-byte Modbus TCP write request for one register (function 0x06).
 *
 * The write echo is the answer this returns: a 0x06 request and its answer are
 * the same eight bytes, so a device that understood the write repeats what it
 * was told, and a device that did not answers an exception instead.
 */
export function buildWriteRequest(address, value, unitId = DEFAULT_UNIT_ID) {
  const frame = new Uint8Array(12);
  const view = new DataView(frame.buffer);
  view.setUint16(0, 0); // transaction id
  view.setUint16(2, 0); // protocol id
  view.setUint16(4, 6); // length
  frame[6] = unitId;
  frame[7] = FUNC_WRITE_ONE;
  view.setUint16(8, address);
  view.setUint16(10, value & 0xffff);
  return frame;
}

/**
 * Read the register values out of a Modbus TCP answer to a 0x03 request.
 *
 * Registers are big-endian and signed, so a value above 32767 arrives as a
 * negative number in a 16-bit view. Callers that need the unsigned reading use
 * `toUint16` rather than reading the raw array themselves.
 */
export function parseReadAnswer(bytes, address, count) {
  if (bytes.length < 9) throw new ModbusError('Answer too short to be a Modbus frame');
  if (bytes[7] & 0x80) throw new ModbusError(`Modbus exception ${bytes[8]} for ${address}`);
  if (bytes[7] !== FUNC_READ) {
    throw new ModbusError(`Expected function ${FUNC_READ}, got ${bytes[7]} for ${address}`);
  }
  const byteCount = bytes[8];
  if (byteCount !== count * 2) {
    throw new ModbusError(`Expected ${count * 2} register bytes, got ${byteCount}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = [];
  for (let i = 0; i < count; i += 1) {
    values.push(view.getInt16(9 + i * 2));
  }
  return values;
}

/**
 * Confirm that the device echoed a write.
 *
 * A 0x06 answer repeats the request byte for byte. Anything else — an exception,
 * or an echo for a different address — means the write did not land, and saying
 * so here is what stops a scene from believing it set a charging current it
 * never set.
 */
export function parseWriteAnswer(bytes, address, value) {
  if (bytes.length < 12) throw new ModbusError('Answer too short to be a write echo');
  if (bytes[7] & 0x80) throw new ModbusError(`Modbus exception ${bytes[8]} for ${address}`);
  if (bytes[7] !== FUNC_WRITE_ONE) {
    throw new ModbusError(`Expected function ${FUNC_WRITE_ONE}, got ${bytes[7]} for ${address}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const echoedAddress = view.getUint16(8);
  const echoedValue = view.getUint16(10);
  if (echoedAddress !== address) {
    throw new ModbusError(`Device echoed address ${echoedAddress}, asked to write ${address}`);
  }
  if (echoedValue !== (value & 0xffff)) {
    throw new ModbusError(`Device echoed value ${echoedValue}, asked to write ${value}`);
  }
  return true;
}

/** One register as an unsigned number. */
export function toUint16(value) {
  return value & 0xffff;
}

/** Two registers, high word first, as a 32-bit unsigned accumulator. */
export function toAcc32([high, low]) {
  return (high >>> 0) * 65536 + (low >>> 0);
}

/**
 * Trim the noise a device sends, e.g. 3.6899998 -> 3.69.
 * Three decimals are far below what a household meter can measure, and the
 * values stay readable in Gladys.
 */
export function round(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

/**
 * The Modbus client of the wallbox: one socket, one request at a time.
 *
 * `transport` is anything with `request(frame)`: the real `ModbusSocket`, or a
 * stand-in handed in by the tests. That is the seam that keeps this file
 * testable without a device.
 */
export class VestelModbus {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} [options.port] Modbus port, 502 by default
   * @param {number} [options.unitId] the EVC04 answers on 255
   * @param {number} [options.timeoutMs]
   * @param {object} [options.transport]
   */
  constructor({ host, port = 502, unitId = DEFAULT_UNIT_ID, timeoutMs = 5000, transport } = {}) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.timeoutMs = timeoutMs;
    this.transport = transport ?? new ModbusSocket({ host, port, responseTimeoutMs: timeoutMs });
    // Optional hook: the caller logs what was tolerated instead of failing.
    this.warn = null;
    // Optional diagnostic hook for temporary, targeted troubleshooting.
    // It is deliberately separate from `warn`: a successful read is not a warning.
    this.diagnostic = null;
  }

  /** Serial-number and firmware block: the cheap way to prove the device talks. */
  async readIdentity(registers) {
    // Imported lazily through the argument so this class stays free of the map,
    // and the tests can hand in a three-register stand-in.
    const read = (spec) => this.readBlock(spec.address, spec.count);
    return {
      serial: await this.readString(registers.serial).catch(() => null),
      brand: await this.readString(registers.brand).catch(() => null),
      model: await this.readString(registers.model).catch(() => null),
      firmware: await this.readString(registers.firmware).catch(() => null),
      _read: read,
    };
  }

  /** Read `count` registers at `address` and return them as signed numbers. */
  async readBlock(address, count) {
    const frame = buildReadRequest(address, count, this.unitId);
    try {
      const bytes = await this.transport.request(frame);
      return parseReadAnswer(bytes, address, count);
    } catch (err) {
      throw new ModbusError(`${err.message} (asked for ${address}x${count})`);
    }
  }

  /** Read one register as an unsigned 16-bit number. */
  async readUint16(address) {
    const [value] = await this.readBlock(address, 1);
    return toUint16(value);
  }

  /**
   * Read one register as an unsigned number, or null for the "not available"
   * sentinel.
   *
   * The sentinel is 0x8000 as a signed int16. It is not a measurement, and
   * publishing it would write nonsense into the Gladys history; a caller can
   * therefore tell "the device does not provide this" from "the value is zero".
   */
  async readOptionalUint16(address) {
    const [value] = await this.readBlock(address, 1);
    if (value === NOT_AVAILABLE) return null;
    return toUint16(value);
  }

  /** Read two registers, high word first, as an unsigned 32-bit number. */
  async readAcc32(address) {
    const words = await this.readBlock(address, 2);

    // Temporary diagnostic for the cumulative energy meter only (registers
    // 1036–1037). Log the two actual 16-bit words as unsigned numbers as well as
    // the combined 32-bit value. This lets us distinguish a real zero from a
    // decoding/word-order problem without changing any value sent to Gladys.
    // Other 32-bit readings are intentionally left alone to keep the logs useful.
    if (address === 1036) {
      const rawWords = words.map(toUint16);
      const unavailable = words.includes(NOT_AVAILABLE);
      const combined = unavailable ? null : toAcc32(words);
      this.diagnostic?.(
        `Meter Reading diagnostic (registers 1036-1037): raw=[${rawWords.join(', ')}], ` +
          `combined=${combined === null ? 'not available' : combined} (unit: 0.1 kWh)`,
      );
    }

    if (words.includes(NOT_AVAILABLE)) return null;
    return toAcc32(words);
  }

  /** SunSpec-style strings do not exist here: the device pads with two chars per register. */
  async readString({ address, count }) {
    const values = await this.readBlock(address, count);
    let text = '';
    for (const value of values) {
      if (value === 0) break;
      text += String.fromCharCode((value >> 8) & 0xff, value & 0xff);
    }
    return text.replace(/\0/g, '').trim();
  }

  /** Write one register and confirm the device echoed it. */
  async writeRegister(address, value) {
    const frame = buildWriteRequest(address, value, this.unitId);
    try {
      const bytes = await this.transport.request(frame);
      parseWriteAnswer(bytes, address, value & 0xffff);
      return value;
    } catch (err) {
      throw new ModbusError(`${err.message} (writing ${value} to ${address})`);
    }
  }
}
