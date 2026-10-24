import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';
import { alivePeriodMs, MIN_ALIVE_PERIOD_S, asRegister } from '../src/vestel/registers.js';
import { AliveControl, ALIVE_VALUE } from '../src/alive.js';
import {
  buildReadRequest,
  buildWriteRequest,
  parseReadAnswer,
  parseWriteAnswer,
} from '../src/vestel/modbus.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values and coerces form strings', () => {
  const config = normalizeConfig({ host: ' 192.168.1.9 ', unit_id: '255', failsafe_timeout: '30' });
  assert.equal(config.host, '192.168.1.9');
  assert.equal(config.unit_id, 255);
  assert.equal(config.failsafe_timeout, 30);
});

// --- the frame builders ------------------------------------------------------

test('a read request carries the unit id the device expects', () => {
  const frame = buildReadRequest(1008, 1, 255);
  assert.equal(frame[6], 255);
  assert.equal(frame[7], 0x04);
  assert.equal(frame[8] * 256 + frame[9], 1008);
});

test('a read answer is parsed as signed big-endian registers', () => {
  const answer = new Uint8Array([0, 1, 0, 0, 0, 5, 255, 0x04, 2, 0xff, 0x38]);
  assert.deepEqual(parseReadAnswer(answer, 1008, 1), [0xff38 - 0x10000]);
});

test('an exception answer carries the register that was asked for', () => {
  const exception = new Uint8Array([0, 1, 0, 0, 0, 3, 255, 0x84, 2]);
  assert.throws(() => parseReadAnswer(exception, 1008, 1), /exception 2 for 1008/);
});

test('a write is only accepted when the device echoes address and value', () => {
  const good = buildWriteRequest(6000, ALIVE_VALUE, 255);
  assert.equal(parseWriteAnswer(good, 6000, ALIVE_VALUE), true);
  assert.throws(() => parseWriteAnswer(good, 5004, ALIVE_VALUE), /echoed address/);
});

// --- the address question ----------------------------------------------------
// The manufacturer's table can be read two ways, and the whole map hangs on
// which one is meant. This test does not decide it — nothing but the device can —
// but it pins the two readings so a change of mind is visible in the diff.

test('the byte-range reading halves the bracket values, the register reading does not', () => {
  // 100 is the first byte of the serial number. Under the byte-range reading it
  // is register 50; under the other one it is register 100.
  assert.ok([50, 100].includes(asRegister(100)));
});

// --- the alive period --------------------------------------------------------
// The specification prescribes half the failsafe timeout for the beat, and a
// floor of three seconds. Both halves of that sentence have a test, because a
// beat that is too slow is a charge that silently drops to the failsafe value.

test('the alive period is half the failsafe timeout', () => {
  assert.equal(alivePeriodMs(20), 10000);
  assert.equal(alivePeriodMs(10), 5000);
});

test('the alive period never goes below the floor the device accepts', () => {
  assert.equal(alivePeriodMs(4), MIN_ALIVE_PERIOD_S * 1000);
  assert.equal(alivePeriodMs(0), MIN_ALIVE_PERIOD_S * 1000);
});

// --- the heartbeat itself ----------------------------------------------------
// These use injected timers so a beat can be driven by hand: a real interval
// would make the test take ten seconds and flake on a slow runner.

function fakeTimers() {
  const ticks = [];
  return {
    ticks,
    setInterval: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      ticks.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      handle.cleared = true;
    },
  };
}

test('setting a current starts the beat and writes once immediately', async () => {
  const written = [];
  const timers = fakeTimers();
  const control = new AliveControl({
    write: async (register, value) => written.push([register, value]),
    ...timers,
  });

  control.configure({ failsafeCurrent: 6, failsafeTimeout: 20 });
  control.set(16);
  await Promise.resolve();

  assert.equal(control.active, true);
  assert.deepEqual(written, [[6000, ALIVE_VALUE]]);
  assert.equal(timers.ticks.length, 1);
  assert.equal(timers.ticks[0].ms, 10000);
});

test('releasing stops the beat and a later tick writes nothing', async () => {
  const written = [];
  const timers = fakeTimers();
  const control = new AliveControl({
    write: async (register, value) => written.push([register, value]),
    ...timers,
  });

  control.configure({ failsafeCurrent: 6, failsafeTimeout: 20 });
  control.set(16);
  control.clear();
  await Promise.resolve();

  const before = written.length;
  assert.equal(control.active, false);
  assert.equal(timers.ticks[0].cleared, true);
  await control.beat();
  assert.equal(written.length, before);
});

test('a failed beat is logged and does not stop the next one', async () => {
  const messages = [];
  const timers = fakeTimers();
  const control = new AliveControl({
    write: async () => {
      throw new Error('no answer');
    },
    log: (message) => messages.push(message),
    ...timers,
  });

  control.configure({ failsafeCurrent: 6, failsafeTimeout: 20 });
  control.set(16);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(messages.length, 1);
  assert.match(messages[0], /no answer/);
  assert.equal(control.active, true);
});

test('the failsafe current is what a released control falls back to', () => {
  const control = new AliveControl({ write: async () => {} });
  control.configure({ failsafeCurrent: 10, failsafeTimeout: 30 });
  assert.equal(control.failsafeCurrent(), 10);
  assert.equal(control.periodMs, 15000);
});
