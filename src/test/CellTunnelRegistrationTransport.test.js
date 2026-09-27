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
const { listenRegistrationOnTunnel, registerOverTunnel } = require('../lib/CellTunnelRegistrationTransport');

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
