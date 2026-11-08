'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { openMainBootstrapInstallationHost } = require('../lib/MainBootstrapInstallationHost');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { StateStore } = require('../lib/StateStore');
const { CellUserDescriptorStore } = require('../lib/CellUserDescriptorStore');
const { CellDataKeyStore } = require('../lib/CellDataKeyStore');
const { CellSettingsPublisher } = require('../lib/CellSettingsPublisher');
const { CellRoutingOutbox } = require('../lib/CellRoutingOutbox');

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
      settings: { desiredRevision: null, confirmedRevision: null, awaitingAck: false },
      maintenance: { version: null, action: null, targetVersion: null, completed: false, matchesMain: false },
      backup: { generation: null, confirmed: false } },
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

test('Main reconciles persisted client assignments into idempotent signed Cell revisions', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-main-assignments-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const userStateFile = path.join(directory, 'state.json');
  const id = 'c'.repeat(32);
  const cellKey = Buffer.alloc(32, 12).toString('base64url');
  const key = byte => Buffer.alloc(32, byte).toString('base64');
  const state = { version: 4, auth: { passwordHash: 'hash', sessionSecret: 'secret' },
    server: { interfaceName: 'awg0', wanInterface: 'eth0', privateKey: key(1),
      publicKey: key(2), address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24',
      listenPort: 51820, panelPort: 51821, endpointHost: 'main.example.test',
      profile: generateOfficialProfile() },
    clients: [
      { id: 'home', name: 'Owner', networkGroup: 'home', enabled: true,
        address4: '10.8.0.2', privateKey: key(3), publicKey: key(4) },
      { id: 'remote', name: 'Friend', networkGroup: 'guest', enabled: true,
        entryCellId: id, address4: '10.64.0.2', privateKey: key(5), publicKey: key(6) },
    ] };
  const store = new StateStore(userStateFile);
  await store.save(state);
  const host = await openMainBootstrapInstallationHost({ ...options(), stateDirectory: directory,
    userStateFile, prepareStateDirectory: async () => {},
    withLock: async ({ work }) => work() });
  await host.identityStore.create('controller');
  host.bootstrapStore.read = async () => ({ invitations: [{ id, status: 'consumed',
    phase: 'closed', cellKey, awgPublicKey: key(7) }] });
  await assert.rejects(host.reconcileClientAssignments(), /not announced/);
  const suffix = crypto.createHash('sha256').update(cellKey).digest('hex');
  const descriptorStore = new CellUserDescriptorStore(
    path.join(directory, 'cell-descriptors', `${suffix}.json`));
  await descriptorStore.update({ version: 1, endpointHost: 'cell.example.test',
    endpointPort: 51830, serverPublicKey: key(8), address4: '10.64.0.1',
    ipv4Subnet: '10.64.0.0/24', profile: generateOfficialProfile() });
  assert.deepEqual(await host.reconcileClientAssignments(), { published: 1 });
  assert.deepEqual(await host.reconcileClientAssignments(), { published: 0 });
  const publisher = new CellSettingsPublisher(path.join(directory, 'cell-settings', `${suffix}.json`),
    host.identityStore, cellKey);
  let desired = (await publisher.load()).desired;
  assert.equal(desired.revision, 1);
  assert.equal(JSON.parse(desired.payload).clients[0].publicKey, key(6));
  assert.equal(desired.payload.includes(key(5)), false);
  await store.save({ ...state, clients: [state.clients[0]] });
  assert.deepEqual(await host.reconcileClientAssignments(), { published: 1 });
  desired = (await publisher.load()).desired;
  assert.equal(desired.revision, 2);
  assert.deepEqual(JSON.parse(desired.payload), { schema: 1, clients: [] });
});

test('Main prepares one immutable Cell data offer from pinned announcements and a free host slot', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-main-data-offer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const userStateFile = path.join(directory, 'state.json');
  const key = byte => Buffer.alloc(32, byte).toString('base64');
  const cellKey = Buffer.alloc(32, 21).toString('base64url');
  const id = 'd'.repeat(32);
  await new StateStore(userStateFile).save({ version: 4,
    auth: { passwordHash: 'hash', sessionSecret: 'secret' },
    server: { interfaceName: 'awg0', wanInterface: 'eth0', privateKey: key(1),
      publicKey: key(2), address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24',
      address6: 'fd42:8::1', ipv6Subnet: 'fd42:8::/64',
      listenPort: 51820, panelPort: 51821, endpointHost: 'main.example.test',
      profile: generateOfficialProfile() },
    clients: [{ id: 'home', name: 'Owner', networkGroup: 'home', enabled: true,
      address4: '10.8.0.2', privateKey: key(3), publicKey: key(4) }] });
  const reservations = [], staged = [], activated = [];
  let live = false;
  const host = await openMainBootstrapInstallationHost({ ...options(),
    stateDirectory: directory, userStateFile,
    keyManager: { generateKeyPair: async () => ({ privateKey: key(30), publicKey: key(31) }),
      derivePublicKey: async value => value === key(30) ? key(31) : key(99),
      generatePeerKeys: async () => ({ privateKey: key(30), publicKey: key(31),
        presharedKey: key(32) }) },
    prepareStateDirectory: async () => {}, withLock: async ({ work }) => work(),
    runner: async (file, args) => {
      if (file === 'awg' && args[0] === 'show') return { stdout: `${key(23)}\t0\n` };
      throw new Error('Unexpected host command');
    },
    preflight: async input => { reservations.push(input); return { free: true }; },
    newDataDeployment: input => ({ ...input,
      store: { read: async () => staged[0]?.expected.plan || null },
      buildPath: () => ({ interfaceName: 'awgd0', verifyOperational: async () => true }) }),
    newRoutingCoordinator: () => ({ verifyOperational: async () => true }),
    newDataActivationGroup: () => ({ activate: async spec => {
      activated.push(spec); return { ready: true, links: 1 }; } }),
    probeData: async () => live,
    newGeoUpdater: () => ({ current: { database: {} }, load: async () => {} }),
    stageData: async input => { staged.push(input); return { ready: true, guarded: true }; } });
  host.bootstrapStore.read = async () => ({ invitations: [{ id, status: 'consumed',
    phase: 'closed', cellKey, awgPublicKey: key(20), cellAddress: '10.90.8.2',
    permanentDescriptor: { cellAddress: '10.91.8.2' } }] });
  await host.identityStore.create('controller');
  const suffix = crypto.createHash('sha256').update(cellKey).digest('hex');
  await new CellUserDescriptorStore(path.join(directory, 'cell-descriptors', `${suffix}.json`))
    .update({ version: 1, endpointHost: 'cell.example.test', endpointPort: 51830,
      serverPublicKey: key(22), address4: '10.64.0.1', ipv4Subnet: '10.64.0.0/24',
      profile: generateOfficialProfile() });
  await new CellDataKeyStore(path.join(directory, 'cell-data-keys', `${suffix}.json`))
    .reserve({ version: 1, publicKey: key(23) });
  assert.equal(await host.dataPublicKey(id), key(23));
  const first = await host.prepareDataOffer(id);
  assert.equal(first.created, true);
  assert.equal(first.offer.descriptor.endpointPort, 53000);
  assert.equal(first.offer.descriptor.slot, 0);
  assert.equal(first.offer.descriptor.cellAddress4, '10.252.0.2');
  assert.equal(first.offer.descriptor.cellClientSubnet4, '10.64.0.0/24');
  assert.ok(!JSON.stringify(first.offer).includes(key(30)));
  assert.equal(reservations.length, 1);
  assert.deepEqual(await host.stageDataLink(id), { ready: true, guarded: true });
  assert.equal(staged[0].expected.plan.spec.owner.interfaceName, 'awgd0');
  assert.equal(staged[0].deployment.policyTable, 'awg_easy_3_data_0');
  assert.deepEqual(await host.reconcileRoutingViews(), { published: 1 });
  assert.deepEqual(await host.reconcileRoutingViews(), { published: 0 });
  assert.deepEqual(await host.activateDataRouting(), { skipped: 'data-handshake-pending' });
  live = true;
  assert.deepEqual(await host.activateDataRouting(), { ready: true, links: 1 });
  assert.ok(activated[0].interfaces.includes('awgd0'));
  assert.ok(activated[0].commands.some(command => command.args.includes('10.8.0.2/32')));
  assert.deepEqual(await host.activateDataRouting(), { ready: true, links: 1,
    unchanged: true });
  assert.equal(activated.length, 1);
  const routing = await new CellRoutingOutbox(
    path.join(directory, 'cell-routing', `${suffix}.json`),
    { identityStore: host.identityStore, cellKey, nodeId: id }).load();
  const routeView = JSON.parse(routing.payload);
  assert.equal(routeView.links[0].peer, 'main');
  assert.deepEqual(routeView.panel, { address4: '10.8.0.1', port: 51821 });
  assert.ok(!routing.payload.includes(key(3)));
  assert.deepEqual(reservations[0].interfaceNames, ['awgd0']);
  const again = await host.prepareDataOffer(id);
  assert.equal(again.created, false);
  assert.deepEqual(again.offer, first.offer);
  assert.equal(reservations.length, 1);
  await new CellUserDescriptorStore(path.join(directory, 'cell-descriptors', `${suffix}.json`))
    .update({ version: 1, endpointHost: 'cell.example.test', endpointPort: 51830,
      serverPublicKey: key(22), address4: '10.65.0.1', ipv4Subnet: '10.65.0.0/24',
      profile: generateOfficialProfile() });
  await assert.rejects(host.prepareDataOffer(id), /differs from current/);
});
