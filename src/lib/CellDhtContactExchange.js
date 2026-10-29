'use strict';

const crypto = require('node:crypto');
const { contactSalt, targetFor, createCellLocator } = require('./CellDhtLocator');

const DEFAULT_TIMEOUT_MS = 10_000;

function withTimeout(start, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError('Invalid DHT timeout');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('DHT contact request timed out'));
    }, timeoutMs);
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    try { start(done); } catch (error) { done(error); }
  });
}

class CellDhtContactExchange {
  constructor({ dht, cursor, cellKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!dht || typeof dht.put !== 'function' || typeof dht.get !== 'function'
      || !cursor || typeof cursor.reserve !== 'function'
      || typeof cursor.accept !== 'function'
      || cursor.cellKey && cursor.cellKey !== cellKey
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000
      || !Buffer.isBuffer(targetFor(cellKey))) {
      throw new TypeError('DHT transport, cursor and Cell key required');
    }
    this.dht = dht;
    this.cursor = cursor;
    this.cellKey = cellKey;
    this.target = targetFor(cellKey);
    this.timeoutMs = timeoutMs;
  }

  async publish({ privateKey, host, port, now = Date.now() }) {
    // Reject a bad identity or endpoint before reserving a durable sequence.
    const preliminary = createCellLocator({ privateKey, seq: 1, host, port, now });
    if (!preliminary.k.equals(Buffer.from(this.cellKey, 'base64url'))) {
      throw new Error('DHT publication Cell identity mismatch');
    }
    const seq = await this.cursor.reserve(now);
    const options = createCellLocator({ privateKey, seq, host, port, now });
    const result = await withTimeout(done => {
      this.dht.put(options, (error, target, accepted) =>
        done(error, { target, accepted }));
    }, this.timeoutMs);
    if (!Buffer.isBuffer(result.target) || !result.target.equals(this.target)
      || !Number.isSafeInteger(result.accepted) || result.accepted < 1) {
      throw new Error('DHT publication not confirmed');
    }
    return Object.freeze({ seq, accepted: result.accepted });
  }

  async lookup(now = Date.now()) {
    const publicKey = crypto.createPublicKey({ format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: this.cellKey } });
    const expected = Buffer.from(this.cellKey, 'base64url');
    const verify = (sig, message, key) => Buffer.isBuffer(key) && key.equals(expected)
      && crypto.verify(null, message, publicKey, sig);
    const item = await withTimeout(done => {
      this.dht.get(this.target, { salt: contactSalt(), cache: false, verify }, done);
    }, this.timeoutMs);
    if (item === null || item === undefined) return null;
    return this.cursor.accept(item, now);
  }
}

module.exports = { CellDhtContactExchange };
