'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { identity } = require('../lib/CellRegistration');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { normalizeAwgConfig } = require('../lib/CellAwgSnapshot');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { renderBootstrapServerConfig, renderBootstrapCellConfig } = require('../lib/CellAwgBootstrapConfig');

const key = () => crypto.randomBytes(32).toString('base64');
const fixture = async () => {
  const temporaryKeys = { privateKey: key(), publicKey: key(), presharedKey: key() };
  const profile = generateOfficialProfile();
  const invitation = await createAwgBootstrapInvitation({ controllerKey: identity().publicKey,
    endpointHost: 'example.test', endpointPort: 51820, registrationPort: 51822,
    controllerAddress: '10.90.0.1', cellAddress: '10.90.0.2', serverPublicKey: key(),
    profile, keyManager: { generatePeerKeys: async () => temporaryKeys }, now: 1000 });
  return { ...invitation, profile, temporaryKeys };
};

test('bootstrap configs route only the private registration address and no DNS or Internet', async () => {
  const { code, record, profile, temporaryKeys } = await fixture();
  const cell = renderBootstrapCellConfig(code, 1001);
  assert.equal(cell.address, '10.90.0.2/32');
  assert.equal(cell.controllerAddress, '10.90.0.1');
  assert.equal(cell.registrationPort, 51822);
  assert.match(cell.config, /AllowedIPs = 10\.90\.0\.1\/32/);
  assert.match(cell.config, /Endpoint = example\.test:51820/);
  assert.doesNotMatch(cell.config, /(?:^|\n)DNS = |0\.0\.0\.0\/0|::\/0/);
  const server = renderBootstrapServerConfig({ privateKey: key(), listenPort: 51820,
    controllerAddress: '10.90.0.1', profile, peers: [{ ...record, status: 'ready' }] });
  assert.equal(normalizeAwgConfig(server).peers[0].publickey, temporaryKeys.publicKey);
  assert.deepEqual(normalizeAwgConfig(server).peers[0].allowedips, ['10.90.0.2/32']);
  assert.doesNotMatch(server, /Address = |0\.0\.0\.0\/0|::\/0/);
});

test('bootstrap server config refuses duplicate peers and foreign addresses', async () => {
  const { record, profile } = await fixture();
  const base = { privateKey: key(), listenPort: 51820, controllerAddress: '10.90.0.1', profile };
  assert.throws(() => renderBootstrapServerConfig({ ...base, peers: [record, record] }), /duplicate/);
  assert.throws(() => renderBootstrapServerConfig({ ...base, peers: [{ ...record, cellAddress: '8.8.8.8' }] }), /peer/);
  assert.throws(() => renderBootstrapServerConfig({ ...base, peers: [{ ...record, status: 'revoked' }] }), /peer/);
});

test('bootstrap invitation supports a private IPv6-only registration path', async () => {
  const temporaryKeys = { privateKey: key(), publicKey: key(), presharedKey: key() };
  const profile = generateOfficialProfile();
  const { code, record } = await createAwgBootstrapInvitation({ controllerKey: identity().publicKey,
    endpointHost: '2001:db8::21', endpointPort: 51820, registrationPort: 51822,
    controllerAddress: 'fd35:e03:5563::1', cellAddress: 'fd35:e03:5563::2', serverPublicKey: key(),
    profile, keyManager: { generatePeerKeys: async () => temporaryKeys }, now: 1000 });
  const cell = renderBootstrapCellConfig(code, 1001);
  assert.equal(cell.address, 'fd35:e03:5563::2/128');
  assert.match(cell.config, /AllowedIPs = fd35:e03:5563::1\/128/);
  assert.match(cell.config, /Endpoint = \[2001:db8::21\]:51820/);
  const server = renderBootstrapServerConfig({ privateKey: key(), listenPort: 51820,
    controllerAddress: 'fd35:e03:5563::1', profile, peers: [record] });
  assert.deepEqual(normalizeAwgConfig(server).peers[0].allowedips, ['fd35:e03:5563::2/128']);
});
