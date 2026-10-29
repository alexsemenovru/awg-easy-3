'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { identity } = require('../lib/CellRegistration');
const { targetFor, createCellLocator, verifyCellLocator } = require('../lib/CellDhtLocator');

const now = 1_800_000_000_000;
const signed = (options = {}) => {
  const cell = identity();
  const put = createCellLocator({ privateKey: cell.privateKey, seq: 12,
    host: '198.51.100.7', port: 49123, now, ...options });
  const body = Buffer.concat([Buffer.from('4:salt'), Buffer.from(`${put.salt.length}:`), put.salt,
    Buffer.from(`3:seqi${put.seq}e1:v${put.v.length}:`), put.v]);
  return { cell, item: { k: put.k, salt: put.salt, seq: put.seq, v: put.v,
    sig: put.sign(body) } };
};

test('signed DHT locator binds Cell identity, endpoint and sequence', () => {
  const { cell, item } = signed();
  const result = verifyCellLocator(item, { cellKey: cell.publicKey, minimumSeq: 12, now });
  assert.equal(result.host, '198.51.100.7');
  assert.equal(result.port, 49123);
  assert.ok(result.target.equals(targetFor(cell.publicKey)));
  assert.equal(item.v.length < 512, true);
  assert.throws(() => verifyCellLocator({ ...item, seq: 13 },
    { cellKey: cell.publicKey, now }), /Invalid DHT/);
  assert.throws(() => verifyCellLocator({ ...item, v: Buffer.from('{}') },
    { cellKey: cell.publicKey, now }), /Invalid DHT/);
  assert.throws(() => verifyCellLocator(item,
    { cellKey: identity().publicKey, now }), /Invalid DHT/);
  assert.throws(() => verifyCellLocator(item,
    { cellKey: cell.publicKey, minimumSeq: 13, now }), /Invalid DHT/);
  assert.throws(() => verifyCellLocator(item,
    { cellKey: cell.publicKey, now: now + 15 * 60 * 1000 }), /Invalid DHT/);
});

test('DHT locator rejects non-IP contact and oversized or executable fields', () => {
  const cell = identity();
  assert.throws(() => createCellLocator({ privateKey: cell.privateKey, seq: 1,
    host: 'vpn.example', port: 1234, now }), /Invalid DHT/);
  assert.throws(() => createCellLocator({ privateKey: cell.privateKey, seq: 1,
    host: '198.51.100.2', port: 0, now }), /Invalid DHT/);
  const { item } = signed();
  assert.throws(() => verifyCellLocator({ ...item, v: Buffer.alloc(513) },
    { cellKey: cell.publicKey, now }), /Invalid DHT/);
});
