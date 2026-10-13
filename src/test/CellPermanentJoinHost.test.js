'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { openCellPermanentJoinHost } = require('../lib/CellPermanentJoinHost');

const methods = names => Object.fromEntries(names.map(name => [name, async () => {}]));
const bootstrap = () => ({
  lifecycle: methods(['load', 'recover', 'remove']),
  awg: methods(['load', 'retire']),
  firewall: { ...methods(['load', 'recover', 'apply', 'current', 'equal']),
    table: 'awg_easy_3_bootstrap' },
  routes: methods(['load', 'recover', 'apply', 'inventory']),
  guard: { ...methods(['load', 'recover', 'protect', 'release']),
    table: 'awg_easy_3_bootstrap_guard' },
});
const options = () => ({ stateDirectory: path.resolve('private-cell-join'),
  interfaceName: 'awgctl0', temporaryInterfaceName: 'awgjoin0',
  bootstrap: bootstrap(), runner: async () => { throw new Error('No host command expected'); },
  connectionStore: { read: async () => ({ status: 'registered',
    controllerPath: { endpointHost: 'cell.example' } }) },
  withLock: async ({ lockPath, work }) => {
    assert.equal(lockPath, path.resolve('private-cell-join', 'install.lock'));
    return work();
  } });

test('permanent Cell join resolves only the signed endpoint under the installation lock', async () => {
  let passed;
  const host = openCellPermanentJoinHost({ ...options(),
    resolve: async name => {
      assert.equal(name, 'cell.example');
      return [{ address: '127.0.0.1' }, { address: '216.57.108.77' }];
    },
    join: async value => { passed = value; return { status: 'ready' }; } });
  assert.deepEqual(await host.join(), { status: 'ready' });
  assert.equal(passed.interfaceName, 'awgctl0');
  assert.equal(passed.resolvedEndpointHost, '216.57.108.77');
  assert.equal(passed.deployment.stateDirectory,
    path.resolve('private-cell-join', 'permanent'));
  assert.equal(passed.retirement.interfaceName, 'awgjoin0');
});

test('permanent Cell join refuses invalid DNS and unregistered state before mutation', async () => {
  let joined = false;
  const invalid = openCellPermanentJoinHost({ ...options(),
    resolve: async () => [{ address: '127.0.0.1' }],
    join: async () => { joined = true; } });
  await assert.rejects(invalid.join(), /No usable permanent Cell endpoint/);
  const pending = openCellPermanentJoinHost({ ...options(),
    connectionStore: { read: async () => ({ status: 'pending' }) },
    resolve: async () => { throw new Error('Must not resolve'); },
    join: async () => { joined = true; } });
  await assert.rejects(pending.join(), /Signed permanent Cell registration/);
  assert.equal(joined, false);
});

test('permanent Cell recovery keeps the previously reserved address without DNS', async () => {
  let passed;
  const host = openCellPermanentJoinHost({ ...options(),
    makeDeployment: () => ({ store: { read: async () => ({ version: 1 }) },
      buildPath() {} }),
    resolve: async () => { throw new Error('DNS must not run on recovery'); },
    join: async value => { passed = value; return { status: 'ready' }; } });
  assert.deepEqual(await host.join(), { status: 'ready' });
  assert.equal(passed.resolvedEndpointHost, undefined);
});
