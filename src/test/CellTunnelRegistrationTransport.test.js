'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { CellEnrollmentStore } = require('../lib/CellEnrollmentStore');
const { CellRegistrationService } = require('../lib/CellRegistrationService');
const { CellRegistrationHandler } = require('../lib/CellRegistrationHandler');
const { decodeInvitation } = require('../lib/CellInvitation');
const { identity, signRegistration } = require('../lib/CellRegistration');
const { listenRegistrationOnTunnel, registerOverTunnel,
  registerAwgOverTunnel } = require('../lib/CellTunnelRegistrationTransport');
const { CellAwgBootstrapStore } = require('../lib/CellAwgBootstrapStore');
const { createAwgBootstrapInvitation, decodeAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const crypto = require('node:crypto');
const { CellAwgRegistrationService } = require('../lib/CellAwgRegistrationService');
const { signAwgRegistration, parseAwgRegistration } = require('../lib/CellAwgRegistration');

test('registration proof and signed receipt work on a private tunnel address without TLS', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-tunnel-registration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identities = new ControlIdentityStore(path.join(directory, 'identity.json'));
  const controller = await identities.create('controller');
  const store = new CellEnrollmentStore(path.join(directory, 'enrollment.json'));
  const handler = new CellRegistrationHandler(new CellRegistrationService(identities, store));
  const server = await listenRegistrationOnTunnel({ address: '127.0.0.1', port: 0, handler });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const invitation = decodeInvitation(await store.create({ host: '127.0.0.1',
    port: server.address().port, controllerKey: controller.publicKey }));
  const request = signRegistration(invitation, identity().privateKey);
  const options = { address: '127.0.0.1', port: server.address().port,
    controllerKey: controller.publicKey, request };
  assert.equal((await registerOverTunnel(options)).status, 'registered');
  assert.equal((await store.read()).invitations[0].status, 'consumed');
  assert.equal((await registerOverTunnel(options)).status, 'registered');
  await assert.rejects(registerOverTunnel({ ...options, controllerKey: identity().publicKey }),
    /confirmation rejected/);
  assert.throws(() => registerOverTunnel({ ...options, address: '8.8.8.8' }), /private/);
});

test('v2 AWG invitation registers through the private tunnel and is single-use', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-v2-tunnel-registration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identities = new ControlIdentityStore(path.join(directory, 'identity.json'));
  const controller = await identities.create('controller');
  const store = new CellAwgBootstrapStore(path.join(directory, 'bootstrap.json'));
  const key = () => crypto.randomBytes(32).toString('base64');
  const issued = await createAwgBootstrapInvitation({ controllerKey: controller.publicKey,
    endpointHost: 'example.test', endpointPort: 51824, registrationPort: 51822,
    controllerAddress: '10.90.0.1', cellAddress: '10.90.0.2', serverPublicKey: key(),
    profile: generateOfficialProfile(), keyManager: { generatePeerKeys: async () => ({
      privateKey: key(), publicKey: key(), presharedKey: key(),
    }) }, now: Date.now(), lifetimeMs: 60000 });
  await store.reserve(issued.record);
  const handler = new CellRegistrationHandler(new CellAwgRegistrationService(identities, store),
    { parse: parseAwgRegistration });
  const server = await listenRegistrationOnTunnel({ address: '127.0.0.1', port: 0, handler });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const invitation = decodeAwgBootstrapInvitation(issued.code);
  const request = signAwgRegistration(invitation, identity().privateKey,
    { publicKey: key(), presharedKey: key() });
  const options = { address: '127.0.0.1', port: server.address().port,
    controllerKey: controller.publicKey, request };
  await assert.rejects(registerAwgOverTunnel(options), /confirmation rejected/);
  await store.markReady(issued.record.id);
  assert.equal((await registerAwgOverTunnel(options)).status, 'registered');
  assert.equal((await registerAwgOverTunnel(options)).status, 'registered');
  assert.equal((await store.read()).invitations[0].status, 'consumed');
  const another = signAwgRegistration(invitation, identity().privateKey,
    { publicKey: key(), presharedKey: key() });
  await assert.rejects(registerAwgOverTunnel({ ...options, request: another }), /confirmation rejected/);
  await assert.rejects(registerOverTunnel(options), /confirmation rejected/);
});
