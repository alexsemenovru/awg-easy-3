'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { identity } = require('../lib/CellRegistration');
const { signControl, verifyControl, signControlReply, verifyControlReply } = require('../lib/CellControlProtocol');
const { CellControlService } = require('../lib/CellControlService');
const { generateOfficialProfile } = require('../lib/Awg3Config');
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

test('Cell endpoint announcement is signed, bounded and cannot carry private keys', async () => {
  const controller = identity();
  const cell = identity();
  const payload = { version: 1, endpointHost: 'cell.example.test', endpointPort: 51830,
    serverPublicKey: Buffer.alloc(32, 3).toString('base64'), address4: '10.64.0.1',
    ipv4Subnet: '10.64.0.0/24', profile: generateOfficialProfile() };
  const signed = signControl({ controllerKey: controller.publicKey, action: 'announce', payload },
    cell.privateKey);
  assert.deepEqual(verifyControl(bytes(signed), controller.publicKey).payload, payload);
  assert.throws(() => verifyControl(bytes({ ...signed, payload: '{}'}), controller.publicKey));
  let accepted = 0;
  const service = new CellControlService({ identityStore: { load: async () => controller },
    bootstrapStore: { read: async () => ({ version: 2, invitations: [{ status: 'consumed',
      phase: 'closed', cellKey: cell.publicKey, awgPublicKey: 'key', awgPresharedKey: 'psk' }] }) },
    descriptorForCell: () => ({ update: async () => { accepted++; } }) });
  const secret = signControl({ controllerKey: controller.publicKey, action: 'announce',
    payload: { ...payload, privateKey: 'secret' } }, cell.privateKey);
  assert.deepEqual(await service.handle(bytes(secret)), { ok: false, error: 'control_unavailable' });
  assert.equal(accepted, 0);
  const result = await service.handle(bytes(signed));
  assert.equal(verifyControlReply(result, controller.publicKey, signed.requestId).announced, true);
  assert.equal(accepted, 1);
  const stranger = identity();
  const unknown = signControl({ controllerKey: controller.publicKey, action: 'announce',
    payload }, stranger.privateKey);
  assert.deepEqual(await service.handle(bytes(unknown)), { ok: false, error: 'control_unavailable' });
  assert.equal(accepted, 1);
});

test('only the enrolled Cell may pin its separate data-link public key', async () => {
  const controller = identity(), cell = identity();
  const fixed = [];
  const service = new CellControlService({ identityStore: { load: async () => controller },
    bootstrapStore: { read: async () => ({ version: 2, invitations: [{ status: 'consumed',
      phase: 'closed', cellKey: cell.publicKey, awgPublicKey: 'key', awgPresharedKey: 'psk' }] }) },
    dataKeyForCell: () => ({ reserve: async value => { fixed.push(value); } }) });
  const payload = { version: 1, publicKey: Buffer.alloc(32, 8).toString('base64') };
  const request = signControl({ controllerKey: controller.publicKey,
    action: 'announce-data', payload }, cell.privateKey);
  const reply = await service.handle(bytes(request));
  assert.equal(verifyControlReply(reply, controller.publicKey, request.requestId).announced, true);
  assert.deepEqual(fixed, [payload]);
  const secret = signControl({ controllerKey: controller.publicKey,
    action: 'announce-data', payload: { ...payload, privateKey: 'secret' } }, cell.privateKey);
  assert.deepEqual(await service.handle(bytes(secret)), { ok: false, error: 'control_unavailable' });
  const outsider = signControl({ controllerKey: controller.publicKey,
    action: 'announce-data', payload }, identity().privateKey);
  assert.deepEqual(await service.handle(bytes(outsider)), { ok: false, error: 'control_unavailable' });
  assert.equal(fixed.length, 1);
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

test('control replies are signed by the controller and bound to the request', () => {
  const controller = identity();
  const requestId = 'a'.repeat(32);
  const poll = signControlReply({ ok: true, requestId, settings: { revision: 1 } }, controller.privateKey);
  assert.deepEqual(verifyControlReply(poll, controller.publicKey, requestId), poll);
  for (const patch of [{ settings: { revision: 2 } }, { requestId: 'b'.repeat(32) },
    { applied: 1 }, { extra: true }, { signature: poll.signature.slice(1) }]) {
    assert.throws(() => verifyControlReply({ ...poll, ...patch }, controller.publicKey, requestId));
  }
  assert.throws(() => verifyControlReply(poll, identity().publicKey, requestId));
  assert.throws(() => verifyControlReply(poll, controller.publicKey, 'b'.repeat(32)));
  const empty = signControlReply({ ok: true, requestId, settings: null }, controller.privateKey);
  assert.equal(verifyControlReply(empty, controller.publicKey, requestId).settings, null);
  const ack = signControlReply({ ok: true, requestId, applied: 3 }, controller.privateKey);
  assert.equal(verifyControlReply(ack, controller.publicKey, requestId).applied, 3);
  assert.throws(() => signControlReply({ ok: true, requestId, applied: 0 }, controller.privateKey));
});
