'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { openMainBootstrapInstallationHost } = require('../lib/MainBootstrapInstallationHost');

const resources = () => ({ interfaceNames: ['awgmainb0', 'awgmainc0'],
  udpPorts: [53081, 53084], nftTables: ['awg_easy_3_bootstrap',
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
    { ...options(), resources: { ...resources(), nftTables: [] } },
    { ...options(), permanentControllerAddress: '10.90.8.1' },
  ]) {
    await assert.rejects(openMainBootstrapInstallationHost({ ...bad,
      prepareStateDirectory: async () => { prepared = true; } }));
  }
  assert.equal(prepared, false);
});
