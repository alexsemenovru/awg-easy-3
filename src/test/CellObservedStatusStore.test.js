'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellObservedStatusStore } = require('../lib/CellObservedStatusStore');
const { identity } = require('../lib/CellRegistration');
const { CellControlService } = require('../lib/CellControlService');
const { signControl, verifyControl } = require('../lib/CellControlProtocol');

test('observations persist only path and timestamps, throttle writes and reject stale/replayed polls', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-observed-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new CellObservedStatusStore(path.join(directory, 'observed.json'));
  assert.equal(await store.read(), null);
  assert.equal(await store.update('direct', 100, 100), true);
  assert.equal(await store.update('direct', 200, 200), false);
  assert.equal(await store.update('technical', 300, 300), true);
  assert.equal(await store.update('direct', 100, 40000), false);
  assert.equal(await store.update('technical', 300, 40000), false);
  assert.deepEqual(await store.read(), { version: 1, controlPath: 'technical', issuedAt: 300, receivedAt: 300 });
  const reopened = new CellObservedStatusStore(store.filePath);
  assert.equal(await reopened.update('direct', 200, 40000), false);
  assert.throws(() => store.update({ users: 12 }, 500, 500), /Invalid observed/);
  if (process.platform !== 'win32') assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);
});

test('signed observations accept no addresses, statistics or extra fields', () => {
  const main = identity(); const cell = identity();
  const request = payload => Buffer.from(JSON.stringify(signControl({ controllerKey: main.publicKey,
    action: 'poll', payload }, cell.privateKey)));
  for (const payload of [{ controlPath: 'technical', users: 12 }, { controlPath: '127.0.0.1' }, [], 'technical']) {
    assert.throws(() => verifyControl(request(payload), main.publicKey), /Invalid control observation/);
  }
  assert.deepEqual(verifyControl(request({ controlPath: 'technical' }), main.publicKey).payload,
    { controlPath: 'technical' });
});

test('only an enrolled signed poll can update diagnostics and a diagnostic write failure never blocks settings', async () => {
  const main = identity(); const cell = identity(); const foreign = identity();
  const observations = [];
  const service = new CellControlService({ identityStore: { load: async () => main },
    bootstrapStore: { read: async () => ({ version: 2, invitations: [{ status: 'consumed', phase: 'closed',
      cellKey: cell.publicKey, awgPublicKey: 'present', awgPresharedKey: 'present' }] }) },
    observedForCell: key => ({ update: async (...args) => { observations.push([key, ...args]); throw new Error('Disk full'); } }),
    publisherForCell: () => ({ load: async () => ({ desired: null }) }) });
  const bytes = sender => Buffer.from(JSON.stringify(signControl({ controllerKey: main.publicKey,
    action: 'poll', payload: { controlPath: 'technical' } }, sender.privateKey)));
  assert.equal((await service.handle(bytes(foreign))).ok, false);
  assert.equal(observations.length, 0);
  assert.equal((await service.handle(bytes(cell))).ok, true);
  assert.equal(observations.length, 1);
  assert.equal(observations[0][0], cell.publicKey);
  assert.equal(observations[0][1], 'technical');
});
