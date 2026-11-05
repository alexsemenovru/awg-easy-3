'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { identity } = require('../lib/CellRegistration');
const { signAwgRegistration, verifyAwgRegistration,
  signAwgReceipt, verifyAwgReceipt } = require('../lib/CellAwgRegistration');
const { generateOfficialProfile } = require('../lib/Awg3Config');

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

test('signed v3 receipt binds a complete permanent path without exposing the cell private key', () => {
  const f = fixture();
  const permanent = { version: 1, endpointHost: 'controller.example', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey: key(), profile: generateOfficialProfile() };
  const receipt = signAwgReceipt(f.request, f.controller.privateKey, 100002, permanent);
  const verified = verifyAwgReceipt(receipt, f.request, f.controller.publicKey, 100003);
  assert.equal(receipt.version, 3);
  assert.deepEqual(verified.permanent, permanent);
  assert.equal(JSON.stringify(receipt).includes('privateKey'), false);
  for (const patch of [{ endpointPort: 53085 }, { cellAddress: '10.91.8.3' },
    { serverPublicKey: key() }]) {
    assert.throws(() => verifyAwgReceipt({ ...receipt,
      permanent: { ...receipt.permanent, ...patch } }, f.request, f.controller.publicKey, 100003));
  }
  assert.throws(() => signAwgReceipt(f.request, f.controller.privateKey, 100002,
    { ...permanent, endpointHost: 'bad host' }));
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

test('signed v4 registration pins a restored Main live authority for a newly enrolled Cell', () => {
  const f = fixture();
  const authority = identity();
  const permanent = { version: 1, endpointHost: 'controller.example', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey: key(), profile: generateOfficialProfile() };
  const receipt = signAwgReceipt(f.request, f.controller.privateKey, 100002, permanent, authority.publicKey);
  assert.equal(receipt.version, 4);
  assert.equal(verifyAwgReceipt(receipt, f.request, f.controller.publicKey, 100003).authorityKey, authority.publicKey);
  assert.throws(() => verifyAwgReceipt({ ...receipt, authorityKey: identity().publicKey },
    f.request, f.controller.publicKey, 100003));
  assert.throws(() => verifyAwgReceipt({ ...receipt, version: 3 }, f.request, f.controller.publicKey, 100003));
  assert.throws(() => signAwgReceipt(f.request, f.controller.privateKey, 100002, permanent, f.controller.publicKey));
});
