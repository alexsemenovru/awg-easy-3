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
  runtime.gate.verifyCell = async value => { verified = value; return true; };
  await runtime.retirement.authorization();
  assert.equal(verified, connection);
});
