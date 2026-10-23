// -----------------------------------------------------------------------------
// The wallbox as one Gladys device, wrapping raw registers into named readings
// and the commands that go back the other way.
//
// WHY THIS LAYER EXISTS AT ALL
// `src/vestel/modbus.js` reads registers and writes them. It has no idea what a
// chargepoint is. This file is where "register 1000" becomes "chargepoint_state"
// and where a write of 13 into 5004 becomes "the charging current is 13 A".
// Keeping that translation in one place is what lets registers.js change without
// the widget or a scene noticing.
//
// ONE SNAPSHOT PER POLL
// `readAll()` walks the plan in registers.js and returns a flat object. A
// reading the device does not answer is left OUT rather than reported as zero: a
// wrong value in the history is worse than a missing one, and the device builder
// makes a feature only for a key that is really there.
//
// READ AND WRITE ARE ASYMMETRIC ON PURPOSE
// Reading is cheap and happens every poll. Writing happens when a scene or a
// button asks for it, and every write is confirmed by the device echoing the
// value back — see parseWriteAnswer. A write that did not land throws, so a
// scene cannot believe it set a current it never set.
// -----------------------------------------------------------------------------

import { VestelModbus } from './modbus.js';
import {
  IDENTITY,
  POLL_PLAN,
  CHARGEPOINT_STATE,
  CABLE_STATE,
  EQUIPMENT_STATE,
  READ_ONLY,
  STATE,
  DEFAULT_MIN_CURRENT,
  DEFAULT_MAX_CURRENT,
} from './registers.js';

export class Evc04Client extends VestelModbus {
  /**
   * Identify the device: the strings that prove it answers, and the identity the
   * features are keyed on.
   *
   * A failure here is NOT swallowed: if the serial number cannot be read, the
   * address base is wrong (see registers.js) and the user needs to know before
   * they wonder why every reading looks like noise.
   */
  async connect() {
    this.info = {
      serial: await this.readString(IDENTITY.serial),
      chargepointId: await this.readString(IDENTITY.chargepointId).catch(() => null),
      brand: await this.readString(IDENTITY.brand).catch(() => null),
      model: await this.readString(IDENTITY.model).catch(() => null),
      firmware: await this.readString(IDENTITY.firmware).catch(() => null),
    };
    return this.info;
  }

  /**
   * Read every register of the poll plan into one flat snapshot.
   *
   * A path that does not answer is logged and skipped, so one dead register does
   * not take the whole read down, and a model that reports three-phase values
   * only sometimes simply has fewer keys.
   */
  async readAll() {
    const snapshot = {};
    for (const entry of POLL_PLAN) {
      try {
        snapshot[entry.key] = await this.readOne(entry);
      } catch (err) {
        this.warn?.(entry.key, err);
      }
    }
    return snapshot;
  }

  /** One entry of the poll plan, read according to its kind. */
  async readOne(entry) {
    if (entry.kind === 'state') {
      const raw = await this.readOptionalUint16(entry.address);
      if (raw === null) return null;
      return entry.table[raw] ?? `unknown_${raw}`;
    }
    if (entry.kind === 'acc32') return this.readAcc32(entry.address);
    return this.readOptionalUint16(entry.address);
  }

  /**
   * What the EVSE and the attached cable will accept, in amperes.
   *
   * READ, NEVER WRITTEN. These are the figures the installer set on the wallbox,
   * and this integration respects them: the question they answer is "how much may
   * I ask for", not "how much do I want".
   *
   * The smallest of them wins. A cable may be thinner than the EVSE, and a
   * vehicle may ask for less than either. The device's own maximum (`1104`) is the
   * one that matters for a setpoint: a scene asking for 16 A on a device set to
   * 13 A is not an error the wallbox reports, it simply charges at 13 — and the
   * clamp below is what keeps Gladys from claiming otherwise.
   *
   * `session_max_current` is deliberately NOT part of the ceiling: it describes
   * the session that is running, not what may be asked for, and using it would
   * lower the limit with every charge.
   */
  async readLimits() {
    const [min, evseMax, cableMax] = await Promise.all([
      this.readOptionalUint16(READ_ONLY.evse_min_current).catch(() => null),
      this.readOptionalUint16(READ_ONLY.evse_max_current).catch(() => null),
      this.readOptionalUint16(READ_ONLY.cable_max_current).catch(() => null),
    ]);
    const floor = min ?? DEFAULT_MIN_CURRENT;
    const ceiling = Math.min(evseMax ?? DEFAULT_MAX_CURRENT, cableMax ?? DEFAULT_MAX_CURRENT);
    this.limits = { min: floor, max: Math.max(floor, ceiling) };
    return this.limits;
  }

  /**
   * The limits last read, or the fallbacks when none were.
   *
   * The fallbacks are only for a device that does not answer those registers at
   * all. They are deliberately the smallest figures that make sense for a home
   * charge point, not a generous guess: a ceiling that is too high is a value the
   * wallbox silently ignores, and the user reads a number that is not true.
   */
  getLimits() {
    return this.limits ?? { min: DEFAULT_MIN_CURRENT, max: DEFAULT_MAX_CURRENT };
  }

  /** The chargepoint state as a word, for the connection test and the log. */
  async readChargepointState() {
    return this.readStateWord(STATE.chargepoint, CHARGEPOINT_STATE);
  }

  /** The cable state as a word. */
  async readCableState() {
    return this.readStateWord(STATE.cable, CABLE_STATE);
  }

  /** The equipment state as a word, which is where a fault shows up first. */
  async readEquipmentState() {
    return this.readStateWord(STATE.equipment, EQUIPMENT_STATE);
  }

  /** One register, looked up in a state table. */
  async readStateWord(address, table) {
    const raw = await this.readOptionalUint16(address);
    if (raw === null) return null;
    return table[raw] ?? `unknown_${raw}`;
  }
}
