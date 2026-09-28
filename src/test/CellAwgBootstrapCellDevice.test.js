'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { identity } = require('../lib/CellRegistration');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { prepareBootstrapCellDevice } = require('../lib/CellAwgBootstrapCellDevice');
const { specification } = require('../lib/CellAwgLifecycle');
const { normalizeAwgConfig } = require('../lib/CellAwgSnapshot');

const key = () => crypto.randomBytes(32).toString('base64');
async function invitation(endpointHost = 'example.test') {
  return createAwgBootstrapInvitation({ controllerKey: identity().publicKey,
    endpointHost, endpointPort: 51824, registrationPort: 51822,
    controllerAddress: '10.90.0.1', cellAddress: '10.90.0.2', serverPublicKey: key(),
    profile: generateOfficialProfile(), keyManager: { generatePeerKeys: async () => ({
      privateKey: key(), publicKey: key(), presharedKey: key(),
    }) }, now: 1000 });
}

test('signed DNS endpoint becomes a literal AWG peer endpoint for lifecycle readback', async () => {
  const { code } = await invitation();
  let resolvedHost;
  const result = await prepareBootstrapCellDevice({ code, interfaceName: 'awg-enroll', now: 1001,
    resolve: async host => { resolvedHost = host;
      return [{ address: '127.0.0.1' }, { address: '198.51.100.7' }]; } });
  assert.equal(resolvedHost, 'example.test');
  assert.deepEqual(specification(result.spec), result.spec);
  assert.equal(result.resolvedEndpoint, '198.51.100.7:51824');
  assert.equal(normalizeAwgConfig(result.spec.owner.config).peers[0].endpoint,
    '198.51.100.7:51824');
  assert.deepEqual(result.spec.addresses, ['10.90.0.2/32']);
  assert.equal(result.controllerAddress, '10.90.0.1');
});

test('literal IPv6 endpoint bypasses DNS and is retained in the owned config', async () => {
  const { code } = await invitation('2001:db8::7');
  const result = await prepareBootstrapCellDevice({ code, interfaceName: 'awg-enroll', now: 1001,
    resolve: async () => { throw new Error('DNS must not run'); } });
  assert.equal(result.resolvedEndpoint, '[2001:db8::7]:51824');
});

test('unusable DNS result and expired invitation never create a device specification', async () => {
  const { code } = await invitation();
  await assert.rejects(prepareBootstrapCellDevice({ code, interfaceName: 'awg-enroll', now: 1001,
    resolve: async () => [{ address: '127.0.0.1' }] }), /No usable/);
  await assert.rejects(prepareBootstrapCellDevice({ code, interfaceName: 'awg-enroll', now: 1001,
    resolve: async () => { throw new Error('offline'); } }), /resolution failed/);
  await assert.rejects(prepareBootstrapCellDevice({ code, interfaceName: 'awg-enroll', now: 901001 }),
    /Invalid or unavailable/);
});
