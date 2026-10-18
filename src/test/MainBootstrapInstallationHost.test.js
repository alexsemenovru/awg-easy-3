'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openMainBootstrapInstallationHost } = require('../lib/MainBootstrapInstallationHost');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { StateStore } = require('../lib/StateStore');

const resources = () => ({ interfaceNames: ['awgmainb0', 'awgmainc0'],
  udpPorts: [53081, 53084], userInterfaceNames: ['awg0'], userUdpPorts: [51820],
  nftTables: ['awg_easy_3_bootstrap',
    'awg_easy_3_bootstrap_guard', 'awg_easy_3_control', 'awg_easy_3_control_guard'] });
const options = () => ({ stateDirectory: path.resolve('private-main-state'),
  interfaceName: 'awgmainb0', controllerAddress: '10.90.8.1',
  registrationPort: 53082, listenPort: 53081, endpointHost: '203.0.113.1',
  permanentEndpointPort: 53084, permanentControllerAddress: '10.91.8.1',
  permanentControlPort: 53083, resources: resources() });

test('Main assembly opens one private state root without host mutations', async () => {
  const prepared = [];
  const host = await openMainBootstrapInstallationHost({ ...options(),
    prepareStateDirectory: async directory => { prepared.push(directory); },
    runner: async () => { throw new Error('Opening must not invoke host commands'); } });
  assert.deepEqual(prepared, [options().stateDirectory]);
  assert.equal(host.identityStore.filePath, path.join(options().stateDirectory, 'identity.json'));
  assert.equal(host.configStore.filePath, path.join(options().stateDirectory, 'config.json'));
  assert.equal(host.bootstrap.guard.table, 'awg_easy_3_bootstrap_guard');
  assert.equal(host.bootstrap.firewall.table, 'awg_easy_3_bootstrap');
  for (const method of ['initialize', 'resume', 'issue', 'join', 'listen']) {
    assert.equal(typeof host[method], 'function');
  }
});

test('Main auto-start treats any partial bootstrap or guard as recovery state', async () => {
  const host = await openMainBootstrapInstallationHost({ ...options(),
    prepareStateDirectory: async () => {} });
  let config = null;
  let phase = 'empty';
  let invitations = [];
  let permanent = null;
  let guardInterfaces = [];
  host.configStore.read = async () => config;
  host.bootstrap.lifecycle.load = async () => ({ phase });
  host.bootstrapStore.read = async () => ({ invitations });
  host.deployment.store.read = async () => permanent;
  host.bootstrap.guard.load = async () => ({ interfaces: guardInterfaces, pending: null });
  assert.equal(await host.isPristine(), true);
  config = { version: 1 };
  assert.equal(await host.isPristine(), false);
  config = null;
  phase = 'ready';
  assert.equal(await host.isPristine(), false);
  phase = 'empty';
  invitations = [{ id: 'a'.repeat(32) }];
  assert.equal(await host.isPristine(), false);
  invitations = [];
  permanent = { version: 1 };
  assert.equal(await host.isPristine(), false);
  permanent = null;
  guardInterfaces = ['awgmainb0'];
  assert.equal(await host.isPristine(), false);
});

test('Main assembly refuses incomplete or overlapping reservation before storage', async () => {
  let prepared = false;
  for (const bad of [
    { ...options(), resources: { ...resources(), interfaceNames: ['awgmainb0'] } },
    { ...options(), resources: { ...resources(), udpPorts: [53081, 53081] } },
    { ...options(), resources: { ...resources(), userInterfaceNames: ['awgmainb0'] } },
    { ...options(), resources: { ...resources(), userUdpPorts: [53084] } },
    { ...options(), resources: { ...resources(), nftTables: [] } },
    { ...options(), permanentControlPort: 53082 },
    { ...options(), permanentControllerAddress: '10.90.8.1' },
  ]) {
    await assert.rejects(openMainBootstrapInstallationHost({ ...bad,
      prepareStateDirectory: async () => { prepared = true; } }));
  }
  assert.equal(prepared, false);
});

test('Main assembly verifies the persisted user interface and ports before any mutation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-main-reservation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const userStateFile = path.join(directory, 'state.json');
  const state = { version: 1, auth: { passwordHash: 'hash', sessionSecret: 'secret' },
    server: { interfaceName: 'awg0', wanInterface: 'eth0', privateKey: 'private',
      publicKey: 'public', address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24',
      listenPort: 51820, panelPort: 51821, endpointHost: 'vpn.example.org',
      profile: generateOfficialProfile() },
    clients: [{ id: 'home', name: 'Home', enabled: true, networkGroup: 'home',
      address4: '10.8.0.2', privateKey: 'private', publicKey: 'public' }] };
  const store = new StateStore(userStateFile);
  let preparations = 0;
  const open = () => openMainBootstrapInstallationHost({ ...options(), userStateFile,
    prepareStateDirectory: async () => { preparations++; },
    runner: async () => { throw new Error('Opening must not invoke host commands'); } });
  await assert.rejects(open(), /does not match/);
  await store.save(state);
  await open();
  assert.equal(preparations, 1);
  for (const server of [
    { ...state.server, interfaceName: 'awg9' },
    { ...state.server, listenPort: 51825 },
    { ...state.server, panelPort: 53082 },
    { ...state.server, panelPort: 53083 },
    { ...state.server, ipv4Subnet: '10.90.8.0/24' },
    { ...state.server, ipv4Subnet: '10.91.8.0/24' },
  ]) {
    await store.save({ ...state, server });
    await assert.rejects(open(), /does not match/);
  }
  await store.save({ ...state, server: { ...state.server,
    address6: 'fd42:8:3::1', ipv6Subnet: 'fd42:8:3::/64' } });
  await assert.rejects(openMainBootstrapInstallationHost({ ...options(), userStateFile,
    controllerAddress: 'fd42:8:3::2',
    prepareStateDirectory: async () => { preparations++; } }), /does not match/);
  assert.equal(preparations, 1);
});

test('Main Cell inventory exposes only public lifecycle and revision fields', async () => {
  const host = await openMainBootstrapInstallationHost({ ...options(),
    prepareStateDirectory: async () => {} });
  host.identityStore.load = async () => ({ publicKey: 'controller-public' });
  host.bootstrapStore.read = async () => ({ invitations: [
    { id: 'a'.repeat(32), status: 'pending', phase: 'ready', createdAt: 1000,
      secretHash: 'do-not-report', temporaryPresharedKey: 'secret' },
    { id: 'b'.repeat(32), status: 'consumed', phase: 'closed', createdAt: 2000,
      cellKey: 'cell-secret', awgPublicKey: 'peer-key', cellAddress: '10.90.8.2' },
  ] });
  assert.deepEqual(await host.cells(), [
    { id: 'a'.repeat(32), status: 'pending', phase: 'ready', createdAt: 1000 },
    { id: 'b'.repeat(32), status: 'consumed', phase: 'closed', createdAt: 2000,
      settings: { desiredRevision: null, confirmedRevision: null, awaitingAck: false } },
  ]);
});

test('Main publishes one empty signed revision for a newly joined Cell', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-main-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const host = await openMainBootstrapInstallationHost({ ...options(), stateDirectory: directory,
    prepareStateDirectory: async () => {},
    withLock: async ({ work }) => work() });
  await host.identityStore.create('controller');
  const cellKey = Buffer.alloc(32, 9).toString('base64url');
  const id = 'b'.repeat(32);
  host.bootstrapStore.read = async () => ({ invitations: [{ id, status: 'consumed',
    phase: 'closed', cellKey, awgPublicKey: Buffer.alloc(32, 8).toString('base64') }] });
  assert.deepEqual(await host.ensureInitialSettings(id), { created: true });
  assert.deepEqual(await host.ensureInitialSettings(id), { created: false });
  assert.deepEqual(await host.settingsStatus(id), { desiredRevision: 1,
    confirmedRevision: null, awaitingAck: true });
});
