'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { identity } = require('../lib/CellRegistration');
const { signAwgRegistration, verifyAwgRegistration,
  signAwgReceipt, verifyAwgReceipt } = require('../lib/CellAwgRegistration');

const key = () => crypto.randomBytes(32).toString('base64');
function fixture() {
  const controller = identity(), cell = identity();
  const invitation = { id: crypto.randomBytes(16).toString('hex'),
    controllerKey: controller.publicKey, secret: crypto.randomBytes(32).toString('base64url') };
  const awg = { publicKey: key(), presharedKey: key() };
  const request = signAwgRegistration(invitation, cell.privateKey, awg, 100000);
  return { controller, cell, invitation, awg, request };
}

test('permanent AWG public key and PSK are bound to the cell registration signature', () => {
  const f = fixture();
  const verified = verifyAwgRegistration(f.request, f.controller.publicKey, 100001);
  assert.equal(verified.cellKey, f.cell.publicKey);
  assert.equal(verified.awgPublicKey, f.awg.publicKey);
  assert.equal(verified.awgPresharedKey, f.awg.presharedKey);
  for (const patch of [{ awgPublicKey: key() }, { awgPresharedKey: key() },
    { cellKey: identity().publicKey }, { controllerKey: identity().publicKey },
    { secret: crypto.randomBytes(32).toString('base64url') },
    { requestId: crypto.randomBytes(16).toString('hex') }, { version: 1 },
    { signature: crypto.randomBytes(64).toString('base64url') }, { unexpected: true }]) {
    assert.throws(() => verifyAwgRegistration({ ...f.request, ...patch }, f.controller.publicKey, 100001));
  }
});

test('signed v2 receipt confirms exactly the submitted permanent AWG identity', () => {
  const f = fixture();
  const receipt = signAwgReceipt(f.request, f.controller.privateKey, 100002);
  assert.deepEqual(verifyAwgReceipt(receipt, f.request, f.controller.publicKey, 100003), {
    controllerKey: f.controller.publicKey, cellKey: f.cell.publicKey,
    invitationId: f.invitation.id, status: 'registered',
  });
  assert.throws(() => verifyAwgReceipt(receipt, { ...f.request, awgPublicKey: key() },
    f.controller.publicKey, 100003));
  assert.throws(() => verifyAwgReceipt({ ...receipt, requestHash: crypto.randomBytes(32).toString('base64url') },
    f.request, f.controller.publicKey, 100003));
  assert.throws(() => verifyAwgReceipt(receipt, f.request, identity().publicKey, 100003));
});

test('v2 proof rejects malformed keys, extra fields and expired or future timestamps', () => {
  const f = fixture();
  for (const time of [69999, 400000]) {
    assert.throws(() => verifyAwgRegistration(f.request, f.controller.publicKey, time));
  }
  for (const patch of [{ awgPublicKey: 'bad' }, { awgPresharedKey: null },
    { issuedAt: -1 }, { signature: f.request.signature + '=' }]) {
    assert.throws(() => verifyAwgRegistration({ ...f.request, ...patch }, f.controller.publicKey, 100001));
  }
  assert.throws(() => signAwgRegistration(f.invitation, f.cell.privateKey,
    { publicKey: key(), presharedKey: 'bad' }, 100000));
});
