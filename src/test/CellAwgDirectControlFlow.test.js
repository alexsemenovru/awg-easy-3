'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { CellAwgBootstrapStore } = require('../lib/CellAwgBootstrapStore');
const { CellAwgConnectionStore } = require('../lib/CellAwgConnectionStore');
const { CellAwgBootstrapCoordinator } = require('../lib/CellAwgBootstrapCoordinator');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { listenAwgRegistrationOnTunnel, registerAwgOverTunnel } = require('../lib/CellTunnelRegistrationTransport');
const { listenTunnelControlEndpoint, syncCellSettings } = require('../lib/CellControlService');
const { CellSettingsPublisher } = require('../lib/CellSettingsPublisher');
const { CellSettingsReceiver } = require('../lib/CellSettingsReceiver');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const key = () => crypto.randomBytes(32).toString('base64');
const close = server => new Promise(resolve => server.close(resolve));

test('v2 AWG invitation, permanent identity and signed control form one fail-closed flow on loopback',
  async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-direct-flow-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const controllerIds = new ControlIdentityStore(path.join(directory, 'controller.json'));
    const cellIds = new ControlIdentityStore(path.join(directory, 'cell.json'));
    const controller = await controllerIds.create('controller');
    const cellIdentity = await cellIds.create('cell');
    const bootstrapStore = new CellAwgBootstrapStore(path.join(directory, 'bootstrap.json'));
    const owned = { load: async () => ({ phase: 'ready', spec: {
      owner: { interfaceName: 'testawg' }, addresses: ['127.0.0.1/32'],
    } }), verify: async () => ({ up: true }) };
    const registration = await listenAwgRegistrationOnTunnel({ address: '127.0.0.1', port: 0,
      lifecycle: owned, identityStore: controllerIds, bootstrapStore,
      bootstrapRuntime: { store: bootstrapStore, lifecycle: owned,
        controllerAddress: '127.0.0.1', registrationPort: 0,
        verifyCurrent: async () => true } });
    t.after(() => close(registration));
    const issued = await createAwgBootstrapInvitation({ controllerKey: controller.publicKey,
      endpointHost: 'example.test', endpointPort: 51824,
      registrationPort: registration.address().port,
      controllerAddress: '10.90.0.1', cellAddress: '10.90.0.2',
      serverPublicKey: key(), profile: generateOfficialProfile(),
      keyManager: { generatePeerKeys: async () => ({
        privateKey: key(), publicKey: key(), presharedKey: key(),
      }) }, now: Date.now(), lifetimeMs: 60000 });
    await bootstrapStore.reserve(issued.record);
    await bootstrapStore.markReady(issued.record.id);
    const pair = crypto.generateKeyPairSync('x25519');
    const permanent = {
      privateKey: Buffer.from(pair.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'),
      publicKey: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
      presharedKey: key(),
    };
    const connection = new CellAwgConnectionStore(path.join(directory, 'connection.json'), cellIds,
      { keyManager: { generatePeerKeys: async () => permanent },
        connect: args => registerAwgOverTunnel({ ...args, address: '127.0.0.1' }) });
    await connection.begin(issued.code);
    assert.deepEqual(await connection.resume(), { status: 'registered' });
    assert.equal((await bootstrapStore.read()).invitations[0].awgPublicKey, permanent.publicKey);

    const publisher = new CellSettingsPublisher(path.join(directory, 'desired.json'),
      controllerIds, cellIdentity.publicKey);
    const control = await listenTunnelControlEndpoint({ address: '127.0.0.1', port: 0,
      lifecycle: owned, identityStore: controllerIds, bootstrapStore,
      publisherForCell: () => publisher });
    t.after(() => close(control));
    let applications = 0;
    const receiver = new CellSettingsReceiver(path.join(directory, 'received.json'), {
      controllerKey: controller.publicKey, cellKey: cellIdentity.publicKey,
      apply: async () => { applications++; },
    });
    const options = { connectionStore: connection, identityStore: cellIds, receiver,
      host: '127.0.0.1', port: control.address().port, transport: 'tunnel' };
    await assert.rejects(syncCellSettings(options), /Control reply rejected/);
    let permanentReady = false;
    const coordinator = new CellAwgBootstrapCoordinator({ store: bootstrapStore,
      runtime: { installPeer: async () => {}, verifyPeer: async () => true,
        removePeer: async () => {}, verifyPermanent: async () => permanentReady } });
    await assert.rejects(coordinator.close(issued.record.id), /Permanent cell path not verified/);
    permanentReady = true;
    assert.deepEqual(await coordinator.close(issued.record.id), { closed: true });
    assert.equal((await syncCellSettings(options)).status, 'no-settings');
    await publisher.publish({ schema: 1, clients: [] });
    assert.deepEqual(await syncCellSettings(options), { status: 'applied', revision: 1 });
    assert.equal((await publisher.load()).ack.revision, 1);
    assert.equal(applications, 1);
  });
