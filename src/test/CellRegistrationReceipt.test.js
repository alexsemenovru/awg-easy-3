'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { identity, signRegistration, signReceipt, verifyReceipt } = require('../lib/CellRegistration');
const { createInvitation, decodeInvitation } = require('../lib/CellInvitation');
const { CellRegistrationService } = require('../lib/CellRegistrationService');
const { CellEnrollmentStore } = require('../lib/CellEnrollmentStore');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');

function fixture() {
  const controller = identity();
  const cell = identity();
  const invitation = decodeInvitation(createInvitation({ host: '192.0.2.1', port: 12345,
    controllerKey: controller.publicKey, now: 1000 }).code, 1000);
  const request = signRegistration(invitation, cell.privateKey, 1001);
  return { controller, cell, invitation, request, receipt: signReceipt(request, controller.privateKey, 1002) };
}

test('receipt proves controller possession and contains no invitation secret', () => {
  const { controller, request, receipt } = fixture();
  assert.equal(verifyReceipt(receipt, request, controller.publicKey, 1003).status, 'registered');
  assert.ok(!JSON.stringify(receipt).includes(request.secret));
  assert.throws(() => signReceipt(request, identity().privateKey, 1002));
});

test('receipt is bound to every field and the exact signed request', () => {
  const { controller, cell, invitation, request, receipt } = fixture();
  for (const patch of [{ status: 'deleted' }, { invitationId: 'f'.repeat(32) },
    { requestId: 'f'.repeat(32) }, { cellKey: identity().publicKey },
    { controllerKey: identity().publicKey }, { issuedAt: 1001 },
    { requestHash: identity().publicKey }, { signature: Buffer.alloc(64).toString('base64url') }]) {
    assert.throws(() => verifyReceipt({ ...receipt, ...patch }, request, controller.publicKey, 1003));
  }
  assert.throws(() => verifyReceipt(receipt, signRegistration(invitation, cell.privateKey, 1001), controller.publicKey, 1003));
  for (const clock of [1001, 301001, NaN]) {
    assert.throws(() => verifyReceipt(receipt, request, controller.publicKey, clock));
  }
});

test('service acknowledges only persisted enrollment and retries after reopen', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-receipt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const identities = new ControlIdentityStore(path.join(dir, 'identity.json'));
  const controller = await identities.create('controller');
  const store = new CellEnrollmentStore(path.join(dir, 'enrollment.json'));
  const invitation = decodeInvitation(await store.create({ host: '192.0.2.1', port: 12345,
    controllerKey: controller.publicKey, now: 1000 }), 1000);
  const request = signRegistration(invitation, identity().privateKey, 1001);
  const service = new CellRegistrationService(identities, store);
  const receipt = await service.register(request, 1002);
  assert.equal((await store.read()).invitations[0].status, 'consumed');
  assert.equal(verifyReceipt(receipt, request, controller.publicKey, 1003).status, 'registered');
  const reopened = new CellRegistrationService(identities, new CellEnrollmentStore(store.filePath));
  assert.equal(verifyReceipt(await reopened.register(request, 1004), request, controller.publicKey, 1005).status, 'registered');
  const failing = new CellRegistrationService(identities, { completeSigned: async () => { throw new Error('disk failure'); } });
  await assert.rejects(failing.register(request, 1005), /disk failure/);
});
