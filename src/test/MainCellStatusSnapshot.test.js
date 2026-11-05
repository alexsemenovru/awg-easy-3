'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MainCellStatusSnapshot, validateSnapshot } = require('../lib/MainCellStatusSnapshot');

const cell = () => ({ id: 'a'.repeat(32), status: 'consumed', phase: 'closed',
  createdAt: 100, settings: { desiredRevision: 3, confirmedRevision: 2,
    awaitingAck: true } });

test('Main Cell snapshot rejects secrets and impossible revisions', () => {
  assert.throws(() => validateSnapshot({ version: 1, updatedAt: 200,
    cells: [{ ...cell(), cellKey: 'secret' }] }), /Invalid/);
  assert.throws(() => validateSnapshot({ version: 1, updatedAt: 200,
    cells: [{ ...cell(), settings: { ...cell().settings,
      confirmedRevision: 4 } }] }), /Invalid/);
  assert.throws(() => validateSnapshot({ version: 1, updatedAt: 200,
    cells: [cell(), cell()] }), /Invalid/);
});

test('Main Cell snapshot atomically distinguishes ready, stale and missing data', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-main-status-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'cells.json');
  const store = new MainCellStatusSnapshot(file);
  assert.deepEqual(await store.read({ now: 200 }),
    { state: 'unavailable', updatedAt: null, cells: [] });
  await store.write([cell()], 200);
  assert.deepEqual(await store.read({ now: 300 }),
    { state: 'ready', updatedAt: 200, cells: [cell()] });
  assert.deepEqual(await store.read({ now: 120201 }),
    { state: 'stale', updatedAt: 200, cells: [] });
  if (process.platform !== 'win32') {
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
  }
});

test('Cell control observation exports only a path and a bounded observation time', () => {
  const current = { ...cell(), control: { path: 'technical', receivedAt: 150 } };
  assert.equal(validateSnapshot({ version: 1, updatedAt: 200, cells: [current] }).cells[0].control.path, 'technical');
  for (const control of [{ path: 'technical', receivedAt: 300 },
    { path: 'technical', receivedAt: 150, address: 'private' }, { path: 'relay-key', receivedAt: 150 }]) {
    assert.throws(() => validateSnapshot({ version: 1, updatedAt: 200, cells: [{ ...cell(), control }] }));
  }
});
