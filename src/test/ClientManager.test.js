'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { generateOfficialProfile } = require('../lib/Awg3Config');
const { ClientManager } = require('../lib/ClientManager');
const { validateState } = require('../lib/StateStore');
const { assignmentFromClient, assignmentFingerprint } = require('../lib/CellAssignedSettings');

const profile = () => generateOfficialProfile({
  randomInt: (() => {
    const values = [20, 30, 40, 5];
    return () => values.shift();
  })(),
  generateKey: () => Buffer.alloc(32, 31).toString('base64'),
});

const initialState = () => validateState({
  version: 1,
  auth: { passwordHash: 'password-hash', sessionSecret: 'session-secret' },
  server: {
    interfaceName: 'awg0',
    wanInterface: 'eth0',
    privateKey: 'server-private',
    publicKey: 'server-public',
    address4: '10.8.0.1',
    ipv4Subnet: '10.8.0.0/24',
    listenPort: 51820,
    panelPort: 51821,
    endpointHost: 'vpn.example.com',
    profile: profile(),
  },
  clients: [{
    id: 'home-admin',
    name: 'Home admin',
    enabled: true,
    networkGroup: 'home',
    address4: '10.8.0.2',
    privateKey: 'admin-private',
    publicKey: 'admin-public',
    presharedKey: 'admin-psk',
  }],
});

const fixture = () => {
  let state = initialState();
  const applications = [];
  const manager = new ClientManager({
    store: {
      load: async () => state,
      save: async (next) => { state = validateState(next); return state; },
    },
    applier: { apply: async (input) => { applications.push(input); } },
    keyManager: {
      generatePeerKeys: async () => ({
        privateKey: 'guest-private', publicKey: 'guest-public', presharedKey: 'guest-psk',
      }),
    },
    idGenerator: () => 'new-client',
  });
  return { applications, getState: () => state, manager };
};

test('exit changes persist without replacing client keys, reject unknown nodes, and disable unavailable IPv6', async () => {
  const { manager, getState } = fixture();
  const cellId = 'a'.repeat(32);
  const descriptor = { version: 1, endpointHost: 'cell.example.test', endpointPort: 51830,
    serverPublicKey: Buffer.alloc(32, 4).toString('base64'), address4: '10.64.0.1',
    ipv4Subnet: '10.64.0.0/24', profile: profile() };
  manager.entryDescriptors = async () => ({ [cellId]: descriptor });
  const before = structuredClone(getState().clients[0]);
  const changed = await manager.updateClient(before.id, { exitNodeId: cellId });
  assert.equal(changed.client.exitNodeId, cellId);
  assert.equal(getState().version, 4);
  for (const field of ['privateKey', 'publicKey', 'presharedKey', 'address4']) assert.equal(changed.client[field], before[field]);
  await assert.rejects(manager.updateClient(before.id, { exitNodeId: 'b'.repeat(32) }), /Unknown exit/);
  assert.equal(getState().clients[0].exitNodeId, cellId);
  await manager.updateClient(before.id, { exitNodeId: 'main' });
  assert.equal(getState().clients[0].exitNodeId, 'main');
});

test('Cell retirement disables its profiles without moving them to another exit or replacing their keys', async () => {
  const { manager, getState } = fixture(), cellId = 'a'.repeat(32);
  const descriptor = { version: 1, endpointHost: 'cell.example.test', endpointPort: 51830,
    serverPublicKey: Buffer.alloc(32, 4).toString('base64'), address4: '10.64.0.1',
    ipv4Subnet: '10.64.0.0/24', profile: profile() };
  manager.entryDescriptors = async () => ({ [cellId]: descriptor });
  const guest = await manager.createClient({ name: 'Guest' });
  await manager.updateClient(guest.client.id, { exitNodeId: cellId });
  assert.equal((await manager.disableCellClients(cellId)).affectedClients, 1);
  const disabled = getState().clients.find(client => client.id === guest.client.id);
  assert.equal(disabled.enabled, false); assert.equal(disabled.exitNodeId, cellId);
  assert.equal(disabled.privateKey, guest.client.privateKey);
  assert.equal(getState().clients[0].enabled, true);
});

test('an IPv4-only exit turns IPv6 off and cannot be bypassed through an explicit API toggle', async () => {
  const { manager } = fixture(), id = 'a'.repeat(32);
  let state = initialState();
  state = validateState({ ...state, version: 4,
    server: { ...state.server, address6: 'fd88::1', ipv6Subnet: 'fd88::/64' },
    clients: state.clients.map(client => ({ ...client, address6: 'fd88::2', ipv4Enabled: true, ipv6Enabled: true })) });
  manager.store = { load: async () => state, save: async next => { state = validateState(next); return state; } };
  manager.entryDescriptors = async () => ({ [id]: { version: 1, endpointHost: 'cell.example.test', endpointPort: 51830,
    serverPublicKey: Buffer.alloc(32, 4).toString('base64'), address4: '10.64.0.1', ipv4Subnet: '10.64.0.0/24', profile: profile() } });
  assert.equal((await manager.updateClient('home-admin', { exitNodeId: id })).client.ipv6Enabled, false);
  await assert.rejects(manager.updateClient('home-admin', { ipv6Enabled: true }), { code: 'IPV6_UNAVAILABLE' });
  assert.equal((await manager.updateClient('home-admin', { enabled: true })).client.ipv6Enabled, false);
});

test('new Cell client upgrades state and withholds its profile until Cell confirms the assignment', async () => {
  const { manager, getState, applications } = fixture();
  const cellId = 'a'.repeat(32);
  const descriptor = { version: 1, endpointHost: 'cell.example.test', endpointPort: 51830,
    serverPublicKey: Buffer.alloc(32, 4).toString('base64'), address4: '10.64.0.1',
    ipv4Subnet: '10.64.0.0/24', profile: profile() };
  manager.entryDescriptors = async () => ({ [cellId]: descriptor });
  manager.keyManager.generatePeerKeys = async () => ({
    privateKey: Buffer.alloc(32, 5).toString('base64'),
    publicKey: Buffer.alloc(32, 6).toString('base64'),
    presharedKey: Buffer.alloc(32, 7).toString('base64'),
  });
  const created = await manager.createClient({ name: 'Remote', entryCellId: cellId });
  assert.equal(created.client.entryCellId, cellId);
  assert.equal(created.client.address4, '10.64.0.2');
  assert.equal(getState().version, 4);
  assert.doesNotMatch(applications.at(-1).serverConfig, /10\.64\.0\.2/);
  await assert.rejects(manager.getClientExport(created.client.id), error => error.code === 'CELL_PENDING');
  manager.entryDetails = async () => ({ [cellId]: { confirmed: {
    [created.client.id]: assignmentFingerprint(assignmentFromClient(created.client)),
  } } });
  await assert.rejects(manager.getClientExport(created.client.id), error => error.code === 'CELL_PENDING');
  manager.entryDetails = async () => ({ [cellId]: { routeApplied: true, confirmed: {
    [created.client.id]: assignmentFingerprint(assignmentFromClient(created.client)),
  } } });
  assert.match((await manager.getClientExport(created.client.id)).nativeConfig,
    /Endpoint = cell\.example\.test:51830/);
});

test('country policy updates preserve exported profiles and off removes only geo rules', async () => {
  const { manager, applications, getState } = fixture();
  manager.geoDatabase = () => ({ RU: { ipv4: ['192.0.2.0/24'], ipv6: ['2001:db8::/32'] } });
  const before = await manager.getClientExport('home-admin');
  const saved = await manager.updateClient('home-admin', { geoPolicy: { mode: 'block', countries: ['ru', 'RU'] } });
  assert.deepEqual(saved.client.geoPolicy, { mode: 'block', countries: ['RU'] });
  assert.deepEqual(saved.export, before);
  assert.match(applications.at(-1).nftables, /GeoIP outbound/);
  await manager.updateClient('home-admin', { geoPolicy: { mode: 'off', countries: [] } });
  assert.doesNotMatch(applications.at(-1).nftables, /GeoIP outbound/);
  assert.deepEqual(await manager.getClientExport('home-admin'), before);
  assert.equal(getState().clients[0].networkGroup, 'home');
});

test('missing database or invalid selection cannot save an active geo policy, including disabled clients', async () => {
  const { manager, applications, getState } = fixture();
  await assert.rejects(manager.updateClient('home-admin', { geoPolicy: { mode: 'allow', countries: ['RU'] } }),
    error => error.code === 'GEO_UNAVAILABLE');
  await assert.rejects(manager.updateClient('home-admin', { geoPolicy: { mode: 'allow', countries: [] } }), /Select/);
  assert.equal(getState().clients[0].geoPolicy, undefined);
  assert.equal(applications.length, 0);
  await manager.createClient({ name: 'Guest' });
  await manager.updateClient('new-client', { enabled: false });
  await assert.rejects(manager.updateClient('new-client', { geoPolicy: { mode: 'block', countries: ['RU'] } }),
    error => error.code === 'GEO_UNAVAILABLE');
  assert.equal(getState().clients[1].geoPolicy, undefined);
});

test('rejected new firewall keeps the previously saved country policy', async () => {
  const { manager, getState } = fixture();
  manager.geoDatabase = () => ({ RU: { ipv4: ['192.0.2.0/24'], ipv6: [] } });
  await manager.updateClient('home-admin', { geoPolicy: { mode: 'block', countries: ['RU'] } });
  manager.applier.apply = async () => { throw new Error('nft failure'); };
  await assert.rejects(manager.updateClient('home-admin', { geoPolicy: { mode: 'allow', countries: ['RU'] } }), /nft failure/);
  assert.equal(getState().clients[0].geoPolicy.mode, 'block');
});

test('GeoIP installation is serialized with client mutations and rolls rules back on persistence failure', async () => {
  const { manager, applications } = fixture();
  let release = 'old';
  manager.artifactBuilder = ({ geoDatabase }) => ({ serverConfig: 'same', nftables: geoDatabase.release,
    clientArtifacts: { 'home-admin': {} } });
  manager.geoDatabase = () => ({ release });
  let releaseCommit;
  const gate = new Promise(resolve => { releaseCommit = resolve; });
  const installation = manager.installGeoSnapshot({ database: { release: 'new' } }, async () => {
    await gate;
    throw new Error('disk full');
  });
  const mutation = manager.updateClient('home-admin', { name: 'Renamed' });
  await new Promise(setImmediate);
  assert.deepEqual(applications.map(item => item.nftables), ['new']);
  releaseCommit();
  await assert.rejects(installation, /disk full/);
  await mutation;
  assert.deepEqual(applications.map(item => item.nftables), ['new', 'old', 'old']);
});

test('GeoIP replacement does not persist rejected firewall rules or restart unchanged rules', async () => {
  const { manager, applications } = fixture();
  let committed = false;
  await manager.installGeoSnapshot({ database: {} }, async () => { committed = true; });
  assert.equal(committed, true);
  assert.equal(applications.length, 0);
  manager.artifactBuilder = ({ geoDatabase }) => ({ serverConfig: 'same', nftables: geoDatabase.new ? 'new' : 'old' });
  manager.applier.apply = async () => { throw new Error('nft rejected'); };
  committed = false;
  await assert.rejects(manager.installGeoSnapshot({ database: { new: true } }, async () => { committed = true; }), /nft rejected/);
  assert.equal(committed, false);
});

test('creates a guest by default and returns its AmneziaVPN export', async () => {
  const { applications, getState, manager } = fixture();
  const result = await manager.createClient({ name: 'Guest phone' });
  assert.equal(result.client.networkGroup, 'guest');
  assert.equal(result.client.address4, '10.8.0.3');
  assert.match(result.export.vpnLink, /^vpn:\/\//);
  assert.equal(getState().clients.length, 2);
  assert.equal(applications.length, 1);
  assert.equal(applications[0].interfaceActive, true);
});

test('rejects duplicate client names case-insensitively', async () => {
  const { manager } = fixture();
  await assert.rejects(
    manager.createClient({ name: ' HOME ADMIN ' }),
    (error) => error.code === 'CLIENT_NAME_EXISTS',
  );
});

test('switches network policy and blocks unsafe fields', async () => {
  const { manager } = fixture();
  await manager.createClient({ name: 'Phone' });
  const result = await manager.updateClient('new-client', { networkGroup: 'home' });
  assert.equal(result.client.networkGroup, 'home');
  assert.match(result.export.nativeConfig, /AllowedIPs = 0\.0\.0\.0\/0/);
  await assert.rejects(manager.updateClient('new-client', { publicKey: 'replacement' }), /cannot be changed/);
});

test('protects the last active home client from update and deletion', async () => {
  const { manager } = fixture();
  await assert.rejects(manager.updateClient('home-admin', { networkGroup: 'guest' }), /home client/);
  await assert.rejects(manager.updateClient('home-admin', { enabled: false }), /home client/);
  await assert.rejects(manager.deleteClient('home-admin'), /home client/);
});

test('restores the previous runtime when state persistence fails', async () => {
  let state = initialState();
  const applications = [];
  const manager = new ClientManager({
    store: {
      load: async () => state,
      save: async () => { throw new Error('disk full'); },
    },
    applier: { apply: async (input) => { applications.push(input); } },
    keyManager: {
      generatePeerKeys: async () => ({
        privateKey: 'guest-private', publicKey: 'guest-public', presharedKey: 'guest-psk',
      }),
    },
    idGenerator: () => 'new-client',
  });
  await assert.rejects(manager.createClient({ name: 'Guest' }), /disk full/);
  assert.equal(applications.length, 2);
  assert.match(applications[0].serverConfig, /Guest/);
  assert.doesNotMatch(applications[1].serverConfig, /Guest/);
  assert.equal(state.clients.length, 1);
});
