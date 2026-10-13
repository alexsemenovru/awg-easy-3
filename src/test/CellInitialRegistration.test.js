'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { openCellInitialRegistration } = require('../lib/CellInitialRegistration');

function fixture(status = 'pending', failure) {
  const calls = [];
  let current = status;
  const registration = openCellInitialRegistration({ stateDirectory: path.resolve('cell-state'),
    connectionStore: {
      read: async () => { calls.push('read'); return current ? { status: current } : null; },
      resume: async () => { calls.push('resume'); if (failure) throw failure;
        current = 'registered'; return { status: current }; },
    },
    provisioner: { recover: async () => { calls.push('recover'); } },
    withLock: async ({ lockPath, work }) => { assert.equal(path.basename(lockPath), 'install.lock');
      calls.push('lock'); return work(); },
  });
  return { registration, calls };
}

test('registration verifies owned bootstrap under one lock before sending a request', async () => {
  const f = fixture();
  assert.deepEqual(await f.registration.register(), { status: 'registered' });
  assert.deepEqual(f.calls, ['lock', 'read', 'recover', 'resume']);
  f.calls.length = 0;
  assert.deepEqual(await f.registration.register(), { status: 'registered' });
  assert.deepEqual(f.calls, ['lock', 'read']);
});

test('failed registration retains pending state for safe retry', async () => {
  const f = fixture('pending', new Error('Temporary network unavailable'));
  await assert.rejects(f.registration.register(), /Temporary network unavailable/);
  assert.deepEqual(f.calls, ['lock', 'read', 'recover', 'resume']);
  f.calls.length = 0;
  await assert.rejects(f.registration.register(), /Temporary network unavailable/);
  assert.deepEqual(f.calls, ['lock', 'read', 'recover', 'resume']);
});

test('registration refuses an absent invitation without touching AWG', async () => {
  const f = fixture(null);
  await assert.rejects(f.registration.register(), /Pending Cell bootstrap/);
  assert.deepEqual(f.calls, ['lock', 'read']);
});
