'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { identity } = require('../lib/CellRegistration');
const { createCellLocator } = require('../lib/CellDhtLocator');
const { CellDhtCursorStore } = require('../lib/CellDhtCursorStore');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-dht-cursor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cell = identity();
  const file = path.join(dir, 'private', 'cursor.json');
  return { cell, file, store: new CellDhtCursorStore(file, cell.publicKey) };
}

function signedItem(cell, seq, now) {
  const put = createCellLocator({ privateKey: cell.privateKey, seq, now,
    host: '203.0.113.5', port: 49321 });
  const body = Buffer.concat([Buffer.from('4:salt'),
    Buffer.from(`${put.salt.length}:`), put.salt,
    Buffer.from(`3:seqi${put.seq}e1:v${put.v.length}:`), put.v]);
  return { k: put.k, salt: put.salt, seq: put.seq, v: put.v, sig: put.sign(body) };
}

test('DHT sequence reservation survives restart and clock rollback', async t => {
  const { cell, file, store } = await fixture(t);
  const sequences = await Promise.all([store.reserve(1000), store.reserve(1000),
    store.reserve(1000)]);
  assert.deepEqual(sequences, [1000, 1001, 1002]);
  assert.equal(await new CellDhtCursorStore(file, cell.publicKey).reserve(900), 1003);
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(state, { version: 1, cellKey: cell.publicKey, seq: 1003 });
  await assert.rejects(new CellDhtCursorStore(file, identity().publicKey).read(),
    /Invalid DHT cursor/);
});

test('DHT cursor accepts only verified current or newer locator', async t => {
  const { cell, file, store } = await fixture(t);
  const now = 1_800_000_000_000;
  const first = signedItem(cell, 10, now);
  assert.equal((await store.accept(first, now)).seq, 10);
  assert.equal((await store.accept(first, now)).seq, 10);
  await assert.rejects(store.accept(signedItem(cell, 9, now), now), /Invalid DHT/);
  await assert.rejects(store.accept({ ...first, seq: 11 }, now), /Invalid DHT/);
  assert.equal((await store.accept(signedItem(cell, 11, now), now)).seq, 11);
  await fs.writeFile(file, '{"version":1,"cellKey":"wrong","seq":12}');
  await assert.rejects(store.reserve(now), /Invalid DHT cursor/);
});
