'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPermanentCellRuntime } = require('../lib/CellAwgPermanentCellRuntime');

function bootstrap() {
  const unused = async () => { throw new Error('unexpected bootstrap mutation'); };
  return { lifecycle: { load: unused, recover: unused, remove: unused },
    awg: { load: unused, retire: unused },
    firewall: { table: 'awg_easy_3_bootstrap', load: unused, recover: unused,
      apply: unused, current: unused, equal: () => false },
    routes: { load: unused, recover: unused, apply: unused, inventory: unused },
    guard: { table: 'awg_easy_3_bootstrap_guard', load: unused, recover: unused,
      protect: unused, release: unused } };
}

test('cell assembly binds bootstrap retirement and join to one permanent gate', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-assembly-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let connection = null, verified = null;
  const connectionStore = { read: async () => connection };
  const receiver = { restoreApplied: async () => { throw new Error('unexpected settings restore'); } };
  assert.throws(() => createPermanentCellRuntime({ stateDirectory: directory,
    connectionStore, bootstrap: bootstrap(), temporaryInterfaceName: 'awgjoin8',
    receiver, clientRuntime: {} }), /settings receiver required/);
  assert.throws(() => createPermanentCellRuntime({ stateDirectory: directory,
    connectionStore, bootstrap: bootstrap(), temporaryInterfaceName: 'awgjoin8', receiver }),
  /settings receiver required/);
  const events = [];
  const runtime = createPermanentCellRuntime({ stateDirectory: directory,
    connectionStore, bootstrap: bootstrap(), temporaryInterfaceName: 'awgjoin8', receiver,
    clientRuntime: { prepareBoot: async () => { events.push('guard'); } } });
  assert.deepEqual(await runtime.recoverBoot({ ensureTun: async () => {
    throw new Error('unexpected TUN preflight'); } }), { configured: false, applied: null });
  assert.deepEqual(events, ['guard']);
  assert.equal(runtime.retirement.connection, connectionStore);
  await assert.rejects(runtime.join({ interfaceName: 'awgperm8' }),
    /Signed permanent cell registration required/);
  connection = { status: 'registered' };
  await assert.rejects(runtime.recoverBoot({ ensureTun: async () => {} }),
    /resume join before boot/);
  assert.deepEqual(events, ['guard', 'guard']);
  await assert.rejects(runtime.syncSettings({ identityStore: {} }),
    /no signed permanent control path/);
  runtime.gate.verifyCell = async value => { verified = value; return true; };
  await runtime.retirement.authorization();
  assert.equal(verified, connection);
});

test('cell settings sync uses only the registered permanent AWG address after path verification', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const connection = { status: 'registered', controllerPath: {
    controllerAddress: '10.89.0.1', controlPort: 54321 } };
  const connectionStore = { read: async () => connection };
  const receiver = { restoreApplied: async () => ({ applied: null }) };
  const identityStore = {}, calls = [];
  const runtime = createPermanentCellRuntime({ stateDirectory: directory,
    connectionStore, bootstrap: bootstrap(), temporaryInterfaceName: 'awgjoin8',
    receiver, clientRuntime: { prepareBoot: async () => {} },
    sync: async options => { calls.push(options); return { status: 'no-settings' }; } });
  runtime.gate.verifyCell = async () => false;
  await assert.rejects(runtime.syncSettings({ identityStore }), /not operational/);
  assert.equal(calls.length, 0);
  runtime.gate.verifyCell = async seen => seen === connection;
  assert.deepEqual(await runtime.syncSettings({ identityStore }), { status: 'no-settings' });
  assert.deepEqual(calls, [{ connectionStore, identityStore, receiver,
    host: '10.89.0.1', port: 54321, transport: 'tunnel' }]);
  let poller;
  poller = runtime.createPoller({ identityStore,
    onStatus: status => { if (status.state === 'connected') poller.controller.abort(); } });
  await poller.start();
  assert.equal(calls.length, 2);
  assert.equal(poller.status.state, 'stopped');
});

test('Cell accepts a signed data offer only after the permanent AWG sync succeeds', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-data-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const connectionStore = { read: async () => ({ status: 'registered', controllerPath: {
    controllerAddress: '10.91.8.1', controlPort: 53083 } }) };
  const calls = [], identityStore = {};
  const runtime = createPermanentCellRuntime({ stateDirectory: directory,
    connectionStore, bootstrap: bootstrap(), temporaryInterfaceName: 'awgjoin8',
    receiver: { restoreApplied: async () => ({}) },
    clientRuntime: { prepareBoot: async () => {} },
    dataPublicKey: Buffer.alloc(32, 7).toString('base64'),
    sync: async () => { calls.push('settings'); return { status: 'no-settings' }; },
    fetchDataOffer: async options => { assert.equal(options.host, '10.91.8.1');
      calls.push('fetch'); return { signed: true }; },
    receiveDataOffer: async offer => { assert.deepEqual(offer, { signed: true });
      calls.push('reserve'); },
  });
  runtime.gate.verifyCell = async () => true;
  await runtime.syncSettings({ identityStore });
  assert.deepEqual(calls, ['settings', 'fetch', 'reserve']);
});
