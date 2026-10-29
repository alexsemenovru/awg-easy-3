'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { identity } = require('../lib/CellRegistration');
const { targetFor } = require('../lib/CellDhtLocator');
const { CellDhtContactExchange } = require('../lib/CellDhtContactExchange');

const now = 1_800_000_000_000;
const make = (dht, cellKey = identity().publicKey) => new CellDhtContactExchange({
  dht, cellKey, cursor: {
    reserve: async () => 12,
    accept: async item => item,
  }, timeoutMs: 100 });

test('DHT publication requires acknowledged copies under the expected target', async () => {
  const cell = identity();
  const args = { privateKey: cell.privateKey, host: '203.0.113.5', port: 49000, now };
  const dht = { get() {}, put(options, callback) {
    callback(null, targetFor(cell.publicKey), 0);
  } };
  await assert.rejects(make(dht, cell.publicKey).publish(args), /not confirmed/);
  dht.put = (options, callback) => callback(null, Buffer.alloc(20), 2);
  await assert.rejects(make(dht, cell.publicKey).publish(args), /not confirmed/);
  dht.put = (options, callback) => callback(null, targetFor(cell.publicKey), 2);
  assert.deepEqual(await make(dht, cell.publicKey).publish(args), { seq: 12, accepted: 2 });
  await assert.rejects(make(dht, identity().publicKey).publish(args), /identity mismatch/);
});

test('DHT lookup distinguishes absent record and failed network', async () => {
  const cell = identity();
  const dht = { put() {}, get(target, options, callback) {
    assert.deepEqual(target, targetFor(cell.publicKey));
    assert.equal(options.cache, false);
    callback(null, null);
  } };
  assert.equal(await make(dht, cell.publicKey).lookup(now), null);
  dht.get = (target, options, callback) => callback(new Error('network unavailable'));
  await assert.rejects(make(dht, cell.publicKey).lookup(now), /network unavailable/);
  dht.get = () => {};
  await assert.rejects(make(dht, cell.publicKey).lookup(now), /timed out/);
});
