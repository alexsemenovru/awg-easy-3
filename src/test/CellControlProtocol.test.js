'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { identity } = require('../lib/CellRegistration');
const { signControl, verifyControl } = require('../lib/CellControlProtocol');
const { CellControlService } = require('../lib/CellControlService');
const bytes = value => Buffer.from(JSON.stringify(value));

test('control requests tolerate bounded skew but still reject expired timestamps', () => {
  const controllerKey = identity().publicKey;
  const request = signControl({ controllerKey, action: 'poll' }, identity().privateKey, 100000);
  assert.doesNotThrow(() => verifyControl(bytes(request), controllerKey, 70000));
  assert.doesNotThrow(() => verifyControl(bytes(request), controllerKey, 399999));
  for (const now of [69999, 400000, NaN]) assert.throws(() => verifyControl(bytes(request), controllerKey, now));
});

test('control rate budget bounds malformed requests and refills', async () => {
  let now = 0;
  let loads = 0;
  const service = new CellControlService({ monotonicNow: () => now,
    identityStore: { load: async () => { loads++; throw new Error('invalid'); } } });
  for (let i = 0; i < 16; i++) {
    assert.equal((await service.handle(Buffer.from('bad'))).error, 'control_unavailable');
  }
  assert.equal((await service.handle(Buffer.from('bad'))).error, 'control_busy');
  assert.equal(loads, 16);
  now = 1000;
  assert.equal((await service.handle(Buffer.from('bad'))).error, 'control_unavailable');
  assert.equal(loads, 17);
});

test('control requests are bound to identities, method and payload', () => {
  const controllerKey = identity().publicKey;
  const cell = identity();
  const request = signControl({ controllerKey, action: 'poll' }, cell.privateKey);
  assert.equal(verifyControl(bytes(request), controllerKey).action, 'poll');
  for (const patch of [{ action: 'uninstall' }, { payload: '{}' }, { cellKey: identity().publicKey },
    { issuedAt: 0 }, { command: 'anything' }]) {
    assert.throws(() => verifyControl(bytes({ ...request, ...patch }), controllerKey));
  }
});

test('a valid signature from an unenrolled cell cannot fetch settings', async () => {
  const controller = identity();
  let accessed = false;
  const service = new CellControlService({ identityStore: { load: async () => controller },
    enrollmentStore: { read: async () => ({ invitations: [] }) },
    publisherForCell: () => { accessed = true; } });
  const request = signControl({ controllerKey: controller.publicKey, action: 'poll' }, identity().privateKey);
  assert.deepEqual(await service.handle(bytes(request)), { ok: false, error: 'control_unavailable' });
  assert.equal(accessed, false);
});
