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

test('Main assembly refuses incomplete or overlapping reservation before storage', async () => {
  let prepared = false;
  for (const bad of [
    { ...options(), resources: { ...resources(), interfaceNames: ['awgmainb0'] } },
    { ...options(), resources: { ...resources(), udpPorts: [53081, 53081] } },
    { ...options(), resources: { ...resources(), userInterfaceNames: ['awgmainb0'] } },
    { ...options(), resources: { ...resources(), userUdpPorts: [53084] } },
    { ...options(), resources: { ...resources(), nftTables: [] } },
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
