// -----------------------------------------------------------------------------
// A raw TCP transport for Modbus.
//
// WHY THIS FILE EXISTS, SEPARATE FROM modbus.js
// Modbus TCP is a binary protocol over a plain TCP socket. It is NOT HTTP. So
// this file carries the socket and modbus.js carries the protocol, which keeps
// the register map and the frame parsing testable without opening a socket.
//
// PORTED FROM THE WATTWÄCHTER INTEGRATION, AND WHAT DIFFERS HERE
// The framing is the same, but two of that device's habits are not this one's:
//
//   ONE CLIENT, NOT TWO
//   The WattWächter tolerates two Modbus clients at a time, which is why that
//   integration can afford a careful close-then-open dance. The Vestel EVC04
//   specification says the opposite in as many words: "There can be only one
//   active Modbus master connection at any time." So this process owns exactly
//   one connection, and nothing else — not the connection test, not a scene
//   action — opens a second one. Every request runs on the socket held here.
//
//   UNIT ID 255, NOT 1
//   The unit id is part of the frame, not of the socket, so it is passed in per
//   request rather than fixed here. It comes from the configuration and defaults
//   to 255. A wrong unit id is not an error the device reports: it simply does
//   not answer, which is the hardest kind of failure to read in a log.
//
// HOW MANY BYTES AN ANSWER HAS
// A TCP stream has no message boundaries, so one read may return half a frame or
// two frames at once. The Modbus MBAP header's length field (bytes 5 and 6) says
// how many bytes follow it, so a whole frame is 6 + that length. Anything past
// it belongs to the next answer and stays in the buffer.
//
// TWO WAYS TO GIVE A CONNECTION BACK
//   reset()  destroys the socket and returns AT ONCE. The handle is gone on our
//            side, but the device only learns about it when the FIN arrives, so
//            for a moment it still counts a master as connected. Right for a
//            recovery path that is about to open a new one anyway.
//   close()  ends the socket and WAITS for it to report 'close'. Use this before
//            opening a replacement, and on shutdown — with a single allowed
//            master, a socket left behind can keep the wallbox from answering
//            the next start.
// -----------------------------------------------------------------------------

import { connect as netConnect } from 'node:net';

/** The unit id of a Vestel EVC04, as the specification gives it. */
export const DEFAULT_UNIT_ID = 255;

export class TransportError extends Error {}

export class ModbusSocket {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} [options.port]
   * @param {number} [options.connectTimeoutMs]
   * @param {number} [options.responseTimeoutMs]
   * @param {Function} [options.socketFactory] injectable, for the tests
   */
  constructor({
    host,
    port = 502,
    connectTimeoutMs = 5000,
    responseTimeoutMs = 5000,
    socketFactory = netConnect,
  } = {}) {
    this.host = host;
    this.port = port;
    this.connectTimeoutMs = connectTimeoutMs;
    this.responseTimeoutMs = responseTimeoutMs;
    this.socketFactory = socketFactory;
    this.socket = null;
    // Modbus is strictly one question, one answer, so there is never more than
    // one request in flight.
    this.pending = null;
    this.buffered = Buffer.alloc(0);
    // Queue callers so two pollers cannot overlap on this single-response protocol.
    this.requestQueue = Promise.resolve();
  }

  /** True while a usable connection is open. */
  get isOpen() {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  /** Open the connection if it is not open yet. Resolves when it is usable. */
  async open() {
    if (this.isOpen) return;
    this.socket = await new Promise((resolve, reject) => {
      const socket = this.socketFactory({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new TransportError(`Connection to ${this.host}:${this.port} timed out`));
      }, this.connectTimeoutMs);

      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new TransportError(`${this.host}:${this.port}: ${err.message}`));
      });
    });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (err) => this.fail(err));
    this.socket.on('close', () => this.fail(new TransportError('Connection closed')));
  }

  /** Send one request and resolve with its complete answer frame. */
  request(frame) {
    const run = () => this.performRequest(frame);
    const result = this.requestQueue.then(run, run);
    // A failed request must not poison the queue for every request after it.
    this.requestQueue = result.catch(() => {});
    return result;
  }

  /** One serialized request on the socket. */
  async performRequest(frame) {
    await this.open();
    if (this.pending) throw new TransportError('A request is already in flight');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A request that never answers leaves the connection in an unknown
        // state, so drop it: the next request then starts from a fresh socket
        // instead of inheriting the stuck one.
        this.fail(new TransportError(`No answer within ${this.responseTimeoutMs} ms`));
      }, this.responseTimeoutMs);

      this.pending = {
        resolve: (bytes) => {
          clearTimeout(timer);
          resolve(bytes);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.socket.write(frame);
    });
  }

  /**
   * Collect bytes until a whole Modbus frame is there.
   *
   * The MBAP header's length field counts the bytes that follow it, so a whole
   * frame is `6 + length` bytes. Anything beyond belongs to the next answer and
   * stays in the buffer.
   */
  onData(chunk) {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (!this.pending) return;

    if (this.buffered.length < 6) return;
    const length = this.buffered.readUInt16BE(4);
    const total = 6 + length;
    if (this.buffered.length < total) return;

    const frame = this.buffered.subarray(0, total);
    this.buffered = this.buffered.subarray(total);
    const pending = this.pending;
    this.pending = null;
    pending.resolve(new Uint8Array(frame));
  }

  /**
   * Drop the connection on purpose, so the next request opens a fresh one.
   *
   * WHAT IT DOES NOT DO
   * It does not wait. `destroy()` returns immediately, and the wallbox only
   * learns the master is gone once the FIN reaches it. Use `close()` when a new
   * connection is about to be opened; this one is for recovery paths where
   * waiting would not help anyway.
   */
  reset() {
    const socket = this.socket;
    this.socket = null;
    this.pending = null;
    this.buffered = Buffer.alloc(0);
    if (socket && !socket.destroyed) socket.destroy();
  }

  /** Reject whatever is waiting and drop the connection. */
  fail(err) {
    const pending = this.pending;
    this.pending = null;
    this.socket = null;
    if (!pending) return;
    pending.reject(err instanceof TransportError ? err : new TransportError(err.message));
  }

  /**
   * Close cleanly and WAIT for the handle to be down. Called before opening a
   * replacement, and on shutdown.
   *
   * WHY IT CANNOT SIMPLY AWAIT THE 'close' EVENT
   * A socket that is already destroyed — one that hit an error, or one `reset()`
   * has just thrown away — never fires 'close' again. Waiting on that event
   * would leave the promise pending forever, and the caller with it. So three
   * cases are separated:
   *   - nothing to close    -> return
   *   - already destroyed   -> return, the handle is down by definition
   *   - still open          -> end() and wait, with a short ceiling in case the
   *                           event never comes
   * The ceiling is a backstop, not the normal path: a healthy socket reports
   * 'close' within milliseconds.
   */
  async close() {
    const socket = this.socket;
    this.socket = null;
    this.pending = null;
    this.buffered = Buffer.alloc(0);

    if (!socket) return;
    if (socket.destroyed) return;

    await new Promise((resolve) => {
      // Settled once, whichever comes first. `settle` guards against resolving
      // twice when both the event and the timer fire.
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(ceiling);
        resolve();
      };
      const ceiling = setTimeout(settle, 1000);
      socket.once('close', settle);
      socket.end();
    });
  }
}
