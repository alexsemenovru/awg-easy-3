'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { identity, signRegistration, verifyRegistration } = require('../lib/CellRegistration');
const { createInvitation, decodeInvitation } = require('../lib/CellInvitation');
const { CellEnrollmentStore } = require('../lib/CellEnrollmentStore');

function fixture() {
  const controller = identity();
  const cell = identity();
  const options = { host: '192.0.2.1', port: 12345, controllerKey: controller.publicKey, now: 1000 };
  const invitation = decodeInvitation(createInvitation(options).code, 1000);
  const request = signRegistration(invitation, cell.privateKey, 1001);
  return { controller, cell, options, invitation, request };
}

test('Ed25519 registration binds the cell and the intended controller', () => {
  const { request, cell, controller } = fixture();
  assert.equal(verifyRegistration(request, controller.publicKey, 1002).cellKey, cell.publicKey);
  assert.throws(() => verifyRegistration(request, identity().publicKey, 1002));
});

test('tampering with every signed field fails even with claimed validity flag', () => {
  const { request, controller } = fixture();
  for (const patch of [{ invitationId: 'f'.repeat(32) }, { requestId: 'f'.repeat(32) },
    { cellKey: identity().publicKey }, { controllerKey: identity().publicKey },
    { secret: identity().publicKey }, { issuedAt: 1000 }, { version: 2 },
    { signature: Buffer.alloc(64).toString('base64url') }]) {
    assert.throws(() => verifyRegistration({ ...request, ...patch, registrationValid: true }, controller.publicKey, 1002));
  }
});

test('expired, future, malformed and noncanonical proofs fail', () => {
  const { request, controller } = fixture();
  for (const now of [1000, 301001, NaN]) {
    assert.throws(() => verifyRegistration(request, controller.publicKey, now));
  }
  for (const patch of [{ signature: request.signature + '=' }, { cellKey: 'bad' }, { secret: null }]) {
    assert.throws(() => verifyRegistration({ ...request, ...patch }, controller.publicKey, 1002));
  }
});

test('verified registration persists once and rejects a different signed request', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-proof-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new CellEnrollmentStore(path.join(dir, 'cells.json'));
  const { controller, cell, options } = fixture();
  const invitation = decodeInvitation(await store.create(options), 1000);
  const request = signRegistration(invitation, cell.privateKey, 1001);
  assert.throws(() => store.completeSigned({ ...request, signature: 'bad' }, controller.publicKey, 1002));
  assert.equal((await store.read()).invitations[0].status, 'pending');
  const result = await store.completeSigned(request, controller.publicKey, 1002);
  assert.equal(result.status, 'consumed');
  const reopened = new CellEnrollmentStore(store.filePath);
  assert.deepEqual(await reopened.completeSigned(request, controller.publicKey, 1003), result);
  await assert.rejects(reopened.completeSigned(signRegistration(invitation, cell.privateKey, 1003), controller.publicKey, 1004));
});
