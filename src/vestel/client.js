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
// A SNAPSHOT CARRIES TWO THINGS PER REGISTER: THE NUMBER AND THE WORD
// Every entry of a `kind: 'state'` register is stored as
//
//   { value: 0, word: 'available' }
//
// and not as a bare word or a bare number. The reason is that the two are needed
// by different consumers and must not be derived from each other by guessing:
//
//   - the NUMBER is what a feature is published with (a code is a number),
//   - the WORD is what the sentence on the card is built from.
//
// Deriving the word from the sentence was the earlier mistake: the snapshot held
// the word, `deviceSentence()` looked for a NUMBER, and the card said "Zustand
// unbekannt." while the log said the state had been read. Keeping both, from the
// one table in registers.js, is what makes that impossible.
//
// ONE SNAPSHOT PER POLL
// `readAll()` walks the plan in registers.js and returns that flat object. A
// reading the device does not answer is left OUT rather than reported as zero: a
// wrong value in the history is worse than a missing one, and the device builder
// makes a feature only for a key that is really there.
//
// READ AND WRITE ARE ASYMMETRIC ON PURPOSE
// Reading is cheap and happens every poll. Writing happens when a scene or a
// button asks for it, and every write is confirmed by the device echoing the value
// back — see parseWriteAnswer. A write that did not land throws, so a scene cannot
// believe it set a current it never set.
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

/** Every state table of this device, keyed by the register that uses it. */
export const STATE_TABLES = {
  chargepoint_state: CHARGEPOINT_STATE,
  cable_state: CABLE_STATE,
  equipment_state: EQUIPMENT_STATE,
};

/**
 * Is this snapshot entry a state, i.e. an object carrying its word?
 *
 * THE ONE PLACE THAT KNOWS THE SHAPE. A state is `{ value, word }`; every other
 * reading is a bare number. Deciding that with a `typeof` test at each call site is
 * how the two get mixed up, and it is why this helper exists rather than a repeated
 * test.
 */
const isStateEntry = (entry) => typeof entry === 'object' && entry !== null;

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
   * not take the whole read down, and a model that reports three-phase values only
   * sometimes simply has fewer keys.
   */
  async readAll() {
    const snapshot = {};
    for (const entry of POLL_PLAN) {
      try {
        const value = await this.readOne(entry);
        if (value !== null && value !== undefined) snapshot[entry.key] = value;
      } catch (err) {
        this.warn?.(entry.key, err);
      }
    }

    // The measured total is the sum of the three phase currents. Keep it in
    // amperes with its fractional part in the snapshot; the device/widget layer
    // rounds only the published display value to whole amperes.
    const phaseKeys = ['current_l1', 'current_l2', 'current_l3'];
    if (phaseKeys.every((key) => Number.isFinite(snapshot[key]))) {
      snapshot.total_current = phaseKeys.reduce((sum, key) => sum + snapshot[key], 0) / 1000;
    }

    // Temporary, read-only diagnosis for the reported 0 A session-current issue.
    // These are the unscaled values from this SAME poll, so we can compare the
    // session report with all phases and total power without changing Gladys data.
    const raw = (key) => snapshot[key] ?? 'not available';
    this.diagnostic?.(
      'Charging diagnostic (raw register values): ' +
        `1500 charging_current=${raw('charging_current')} (0.1 A); ` +
        `1008 current_l1=${raw('current_l1')} (mA); ` +
        `1010 current_l2=${raw('current_l2')} (mA); ` +
        `1012 current_l3=${raw('current_l3')} (mA); ` +
        `total_current=${raw('total_current')} (A); ` +
        `1020-1021 power=${raw('power')} (W)`,
    );

    return snapshot;
  }

  /**
   * One entry of the poll plan, read according to its kind.
   *
   * A state is answered as `{ value, word }` — the number for the feature, the
   * word for the sentence. An unknown code keeps its number and gets no word, so
   * the caller can say "unknown" without inventing one.
   */
  async readOne(entry) {
    if (entry.kind === 'state') {
      const raw = await this.readOptionalUint16(entry.address);
      if (raw === null) return null;
      const word = entry.table[raw];
      return { value: raw, word: typeof word === 'string' ? word : null };
    }
    if (entry.kind === 'acc32') return this.readAcc32(entry.address);
    return this.readOptionalUint16(entry.address);
  }

  /**
   * A state's WORD out of the snapshot, or null when there is none.
   *
   * Falls back to the table when the entry arrives as a bare number: a snapshot
   * built by an older reader would otherwise lose its word, and a sentence built
   * without one is worse than a sentence built from the table.
   */
  static stateWord(snapshot, key) {
    const entry = snapshot?.[key];
    if (entry === null || entry === undefined) return null;
    if (isStateEntry(entry)) return entry.word ?? null;
    return STATE_TABLES[key]?.[entry] ?? null;
  }

  /**
   * A bare reading out of the snapshot, or null when it was NOT READ.
   *
   * WHAT NULL MEANS HERE, AND WHY 0 IS NOT NULL
   * `null` means the device did not answer, and only that. A reading of 0 is a
   * reading: register 1500 answers 0 whenever no charging session is running, and
   * register 1008 answers 0 while a car draws nothing. Turning either into `null`
   * drops a feature that the device really reported, and it is what an earlier
   * version did by testing the entry's shape before its value.
   */
  static reading(snapshot, key) {
    const entry = snapshot?.[key];
    if (entry === null || entry === undefined) return null;
    if (isStateEntry(entry)) return entry.value ?? null;
    return entry;
  }

  /**
   * A state's NUMBER out of the snapshot, or null when it was not read.
   *
   * Kept separate from `reading()` on purpose: the two answer the same question for
   * different shapes, and a call site that means "a state's code" must not be able
   * to receive a measurement by accident.
   */
  static stateValue(snapshot, key) {
    const entry = snapshot?.[key];
    if (entry === null || entry === undefined) return null;
    if (isStateEntry(entry)) return entry.value ?? null;
    return STATE_TABLES[key] ? entry : null;
  }

  /**
   * What the EVSE and the attached cable will accept, in amperes.
   *
   * READ, NEVER WRITTEN. These are the figures the installer set on the wallbox,
   * and this integration respects them: the question they answer is "how much may I
   * ask for", not "how much do I want".
   *
    * TWO VALUES DECIDE THE CEILING, AND THE SMALLEST WINS
   * `1104` is the device and `1106` the cable plugged into it. A register that answers
   * 0 is "not reported" and does not lower the ceiling. `1100` (the session maximum)
   * is read for the diagnostic only: it changes during a session while the limits are
   * read once on connect.
   *
   * The floor is 6 A whatever `1102` says: on this device that register answers 0,
   * which is a setpoint the wallbox refuses and no vehicle accepts. The figure
   * comes from the manufacturer's app.
   */
  async readLimits() {
    const [min, evseMax, cableMax, sessionMax] = await Promise.all([
      this.readOptionalUint16(READ_ONLY.evse_min_current).catch(() => null),
      this.readOptionalUint16(READ_ONLY.evse_max_current).catch(() => null),
      this.readOptionalUint16(READ_ONLY.cable_max_current).catch(() => null),
      this.readOptionalUint16(READ_ONLY.session_max_current).catch(() => null),
    ]);
    const floor = DEFAULT_MIN_CURRENT;
    // A register that answers 0 (or nothing) is "not reported", not a limit of 0 A:
    // the device answers 0 for the session and cable maximum when no session is
    // running or no cable is detected. Only a positive value may lower the ceiling.
    const valid = (v) => (Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_CURRENT);
        // The session maximum (1100) is deliberately NOT part of the ceiling: it describes
    // what the running session negotiated, can be small while a car draws little, and
    // these limits are read only on connect, so it would pin the range until the next
    // reconnect. It stays in the diagnostic below.
    const ceiling = Math.min(valid(evseMax), valid(cableMax), DEFAULT_MAX_CURRENT);
    this.limits = {
      min: floor,
      max: Math.max(floor, ceiling),
      reportedMin: min,
      evseMax,
      cableMax,
    };

    // Temporary, read-only diagnosis: show exactly which register narrows the
    // allowed setpoint range. This is essential when the installer configured
    // 6-16 A in the web interface but the integration calculates 6-6 A.
    this.diagnostic?.(
      'Current-limit diagnostic (raw register values, A): ' +
        `1102 evse_min=${min ?? 'not available'}; ` +
        `1104 evse_max=${evseMax ?? 'not available'}; ` +
        `1106 cable_max=${cableMax ?? 'not available'}; ` +
        `1100 session_max=${sessionMax ?? 'not available'}; ` +
        `effective_range=${this.limits.min}-${this.limits.max} A`,
    );
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
