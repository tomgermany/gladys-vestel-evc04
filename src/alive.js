// -----------------------------------------------------------------------------
// The alive heartbeat: the reason a set charging current survives.
//
// WHAT THE DEVICE EXPECTS
// The master writes 1 into register 6000; the wallbox writes 0 back and checks
// the register every `failsafe_timeout / 2` seconds. If it reads 0 when it was
// expecting the master, it concludes the master is gone and switches to the
// FAILSAFE current (register 2000). The period may not go below 3 seconds.
//
// WHY THIS IS NOT AN AFTERTHOUGHT
// Without the heartbeat, a scene sets 16 A, the wallbox charges at 16 A for a
// few seconds and then quietly drops to the failsafe value. Nothing errors,
// nothing is logged, and the car simply charges slower than the scene asked for.
// That is the failure this file exists to prevent, and it is why the heartbeat
// is started by setting a current and stopped by releasing it, rather than
// running all the time.
//
// WHY IT IS A CLASS AND NOT A setInterval AT MODULE SCOPE
// It is started, stopped and re-timed on a configuration change, and each of
// those has to be cancellable and testable. A bare interval has none of that.
// -----------------------------------------------------------------------------

import { FAILSAFE, alivePeriodMs } from './vestel/registers.js';

/** The value the master writes: the wallbox reads it and clears it again. */
export const ALIVE_VALUE = 1;

/** The default failsafe current when the configuration says nothing usable. */
export const DEFAULT_FAILSAFE_CURRENT = 6;

/** The default failsafe timeout in seconds, as the specification gives it. */
export const DEFAULT_FAILSAFE_TIMEOUT_S = 20;

export class AliveControl {
  /**
   * @param {object} options
   * @param {Function} options.write called with (register, value), returns a promise
   * @param {Function} [options.log] called with a message string
   * @param {Function} [options.setInterval] injectable, for the tests
   * @param {Function} [options.clearInterval] injectable, for the tests
   */
  constructor({
    write,
    log = () => {},
    setInterval: setInt = setInterval,
    clearInterval: clearInt = clearInterval,
  } = {}) {
    this.write = write;
    this.log = log;
    this.setInterval = setInt;
    this.clearInterval = clearInt;
    this.timer = null;
    this.periodMs = alivePeriodMs(DEFAULT_FAILSAFE_TIMEOUT_S);
    this.current = null;
    this.failsafe = DEFAULT_FAILSAFE_CURRENT;
    // The beat running right now, so two beats cannot overlap and a stale value
    // cannot be written after a newer one.
    this.beating = null;
  }

  /** True while a charging current is under our control. */
  get active() {
    return this.current !== null;
  }

  /** The current to fall back on when control is released. */
  failsafeCurrent() {
    return this.failsafe;
  }

  /** Apply the configuration: the failsafe values, and with them the beat rate. */
  configure({ failsafeCurrent, failsafeTimeout } = {}) {
    const current = Number(failsafeCurrent);
    if (Number.isFinite(current) && current > 0) this.failsafe = current;
    const timeout = Number(failsafeTimeout);
    this.periodMs = alivePeriodMs(
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_FAILSAFE_TIMEOUT_S,
    );
    // A running beat has to pick up a new period, and stopping and starting is
    // the only way an interval changes its rate.
    if (this.active) this.start();
    return this;
  }

  /**
   * Take control: remember the current and start beating.
   *
   * The first beat is written at once rather than after one period, so a scene
   * that sets a current and then does nothing else has already answered the
   * wallbox by the time the wallbox checks.
   */
  set(current) {
    this.current = Number(current);
    this.start();
    return this.current;
  }

  /** Give control back: stop beating, and forget the current. */
  clear() {
    this.stop();
    this.current = null;
  }

  /** Start (or restart) the beat. */
  start() {
    this.stop();
    this.timer = this.setInterval(() => this.beat(), this.periodMs);
    this.beat();
  }

  /** Stop the beat, if one is running. */
  stop() {
    if (this.timer === null) return;
    this.clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One heartbeat.
   *
   * A failed write is logged and stepped over, not thrown: the next beat is a
   * few seconds away, and the wallbox's own timeout is what protects the car.
   * The one thing this must not do is die silently on the first error — that is
   * exactly the case where the current would fall back to the failsafe value
   * without anyone noticing.
   */
  async beat() {
    if (this.timer === null) return undefined;
    if (this.beating) return this.beating;
    this.beating = this.write(FAILSAFE.alive, ALIVE_VALUE)
      .catch((err) => {
        this.log(`Alive-Register konnte nicht geschrieben werden: ${err.message}`);
      })
      .finally(() => {
        this.beating = null;
      });
    return this.beating;
  }
}
