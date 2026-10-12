'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { identity } = require('../lib/CellRegistration');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { createAwgBootstrapInvitation, decodeAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');

const key = () => crypto.randomBytes(32).toString('base64');
const options = () => {
  const temporaryKeys = { privateKey: key(), publicKey: key(), presharedKey: key() };
  return { controllerKey: identity().publicKey,
    endpointHost: 'example.test', endpointPort: 51820, registrationPort: 51822,
    controllerAddress: '10.90.0.1', cellAddress: '10.90.0.2',
    serverPublicKey: key(), temporaryKeys,
    keyManager: { generatePeerKeys: async () => temporaryKeys },
    profile: generateOfficialProfile(), now: 1000, lifetimeMs: 60000 };
};

test('AWG invitation carries only a temporary peer secret and has a server-side verifier', async () => {
  const input = options();
  const { code, record } = await createAwgBootstrapInvitation(input);
  const decoded = decodeAwgBootstrapInvitation(code, 1001);
  assert.equal(decoded.temporaryPrivateKey, input.temporaryKeys.privateKey);
  assert.equal(decoded.temporaryPresharedKey, input.temporaryKeys.presharedKey);
  assert.equal(decoded.serverPublicKey, input.serverPublicKey);
  assert.equal(decoded.controllerAddress, '10.90.0.1');
  assert.equal(record.temporaryPublicKey, input.temporaryKeys.publicKey);
  assert.equal(record.temporaryPresharedKey, input.temporaryKeys.presharedKey);
  assert.equal(record.cellAddress, '10.90.0.2');
  assert.equal(record.status, 'pending');
  assert.equal(record.secretHash, crypto.createHash('sha256').update(decoded.secret).digest('hex'));
  assert.equal(JSON.stringify(record).includes(input.temporaryKeys.privateKey), false);
  assert.equal(JSON.stringify(record).includes(decoded.secret), false);
  assert.throws(() => decodeAwgBootstrapInvitation(code, decoded.expiresAt), /unavailable/);
});

test('AWG invitation rejects invalid endpoints, internal addresses, keys and extra fields', async () => {
  const base = options();
  for (const patch of [{ endpointHost: 'bad host' }, { endpointHost: '0.0.0.0' },
    { controllerAddress: '127.0.0.1' }, { controllerAddress: '8.8.8.8' },
    { cellAddress: base.controllerAddress }, { cellAddress: 'fd35::2' },
    { endpointPort: 0 }, { registrationPort: 65536 }, { serverPublicKey: 'invalid' },
    { keyManager: { generatePeerKeys: async () => ({ ...base.temporaryKeys, privateKey: 'invalid' }) } },
    { profile: { ...base.profile, surprise: 1 } }, { lifetimeMs: 0 }]) {
    await assert.rejects(createAwgBootstrapInvitation({ ...base, ...patch }));
  }
  const { code } = await createAwgBootstrapInvitation(base);
  const payload = JSON.parse(Buffer.from(code, 'base64url'));
  for (const patch of [{ extra: true }, { cellAddress: '127.0.0.1' },
    { temporaryPrivateKey: 'invalid' }, { profile: { ...payload.profile, unknown: 3 } }]) {
    assert.throws(() => decodeAwgBootstrapInvitation(Buffer.from(JSON.stringify({ ...payload, ...patch })).toString('base64url'), 1001));
  }
});

test('bootstrap invitation reserves separate UDP port and tunnel addresses for permanent AWG', async () => {
  const base = options();
  const permanentDescriptor = { version: 1, endpointHost: base.endpointHost,
    endpointPort: 53084, controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2',
    controlPort: 53083, serverPublicKey: base.serverPublicKey,
    profile: base.profile };
  assert.ok((await createAwgBootstrapInvitation({ ...base, permanentDescriptor }))
    .record.permanentDescriptor);
  for (const patch of [{ endpointPort: base.endpointPort },
    { controllerAddress: base.controllerAddress }, { cellAddress: base.cellAddress }]) {
    await assert.rejects(createAwgBootstrapInvitation({ ...base,
      permanentDescriptor: { ...permanentDescriptor, ...patch } }), /resources overlap/);
  }
});
