'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { openCellBootstrapInstallationHost } = require('../lib/CellBootstrapInstallationHost');

const resources = () => ({ interfaceNames: ['awgjoin0', 'awgctl0'],
  udpPorts: [51822, 51823], nftTables: ['awg_easy_3_bootstrap',
    'awg_easy_3_bootstrap_guard', 'awg_easy_3_control'] });

test('real Cell first-install components share one private state root without touching the host', async () => {
  const stateDirectory = path.resolve('private-cell-state');
  const prepared = [];
  const host = await openCellBootstrapInstallationHost({ stateDirectory,
    interfaceName: 'awgjoin0', resources: resources(),
    prepareStateDirectory: async directory => { prepared.push(directory); },
    runner: async () => { throw new Error('Opening must not invoke host commands'); },
    preflight: async () => {}, withLock: async ({ work }) => work() });
  assert.deepEqual(prepared, [stateDirectory]);
  assert.equal(host.identityStore.filePath, path.join(stateDirectory, 'identity.json'));
  assert.equal(host.connectionStore.filePath, path.join(stateDirectory, 'connection.json'));
  assert.equal(host.permanentPlanStore.filePath, path.join(stateDirectory, 'permanent', 'plan.json'));
  assert.equal(host.bootstrap.guard.table, 'awg_easy_3_bootstrap_guard');
  assert.equal(host.bootstrap.firewall.table, 'awg_easy_3_bootstrap');
  assert.equal(host.provisioner.interfaceName, 'awgjoin0');
  assert.equal(typeof host.initial.begin, 'function');
  assert.equal(typeof host.initial.resume, 'function');
});

test('Cell installation assembly rejects incomplete resource reservations before preparing storage', async () => {
  let prepared = false;
  for (const bad of [
    { ...resources(), interfaceNames: ['awgctl0'] },
    { ...resources(), nftTables: ['awg_easy_3_bootstrap'] },
    { ...resources(), udpPorts: [] },
  ]) {
    await assert.rejects(openCellBootstrapInstallationHost({
      stateDirectory: path.resolve('private-cell-state'), interfaceName: 'awgjoin0', resources: bad,
      prepareStateDirectory: async () => { prepared = true; },
    }), /Complete Cell bootstrap installation reservation/);
  }
  assert.equal(prepared, false);
});
