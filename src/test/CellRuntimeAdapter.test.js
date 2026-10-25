'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CellRuntimeAdapter } = require('../lib/CellRuntimeAdapter');
const { buildCellArtifacts } = require('../lib/CellArtifacts');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const server = () => ({ interfaceName: 'awg0', wanInterface: 'eth0',
  privateKey: Buffer.alloc(32, 1).toString('base64'), listenPort: 12345,
  address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24', profile: generateOfficialProfile() });
const missing = () => Object.assign(new Error('missing'), { code: 1 });

test('default cell guard requires explicit persistent state directory', () => {
  assert.throws(() => new CellRuntimeAdapter({ server: server(),
    runtimeDirectory: path.resolve('runtime') }), /Persistent absolute/);
  assert.throws(() => new CellRuntimeAdapter({ server: server(),
    stateDirectory: 'relative' }), /Persistent absolute/);
  if (process.platform !== 'win32') {
    assert.throws(() => new CellRuntimeAdapter({ server: server(),
      stateDirectory: '/run/awg-easy-3' }), /Persistent absolute/);
  }
});
function guard(events, { failRecover = false, verify = true } = {}) {
  return { recover: async () => { events.push('guard-recover');
    if (failRecover) throw new Error('Foreign or changed routing guard'); },
  current: async () => null,
  protect: async interfaces => { assert.deepEqual(interfaces, ['awg0']); events.push('guard-protect'); },
  release: async check => { events.push('guard-release-start');
    if (!verify || !await check()) throw new Error('Runtime not verified; guard retained');
    events.push('guard-release'); } };
}
const runtime = apply => ({ runtimeDirectory: path.resolve('cell-runtime'),
  tableExists: async () => false, readOptional: async () => null, apply });

test('cell boot restores durable guard before accepting any signed settings', async () => {
  const events = [];
  const adapter = new CellRuntimeAdapter({ server: server(),
    guard: guard(events), runtime: { apply: async () => { events.push('apply'); } } });
  await adapter.prepareBoot();
  assert.deepEqual(events, ['guard-recover', 'guard-protect']);
});

test('cell runtime protects before changing peers and releases only after readback', async () => {
  const events = [];
  const adapter = new CellRuntimeAdapter({ server: server(),
    runner: async file => { if (file === 'ip') throw missing(); return { stdout: '' }; },
    guard: guard(events), verifyRuntime: async () => { events.push('verify'); return true; },
    dockerForwarding: { ensure: async () => { events.push('docker-forwarding'); } },
    runtime: runtime(async value => { events.push('apply');
      assert.equal(value.interfaceActive, false); }) });
  await adapter.apply({ schema: 1, clients: [] });
  assert.deepEqual(events, ['guard-recover', 'guard-protect', 'apply', 'docker-forwarding',
    'guard-release-start', 'verify', 'guard-release']);
});

test('Cell retains the user guard until the signed routing path is verified', async () => {
  const events = [];
  const adapter = new CellRuntimeAdapter({ server: server(), retainGuard: true,
    runner: async file => { if (file === 'ip') throw missing(); return { stdout: '' }; },
    guard: guard(events), verifyRuntime: async () => true,
    dockerForwarding: { ensure: async () => {} },
    runtime: runtime(async () => { events.push('apply'); }) });
  await adapter.apply({ schema: 1, clients: [] });
  assert.deepEqual(events, ['guard-recover', 'guard-protect', 'apply']);
  await assert.rejects(adapter.releaseForRouting(async () => false), /guard retained/);
  assert.ok(!events.includes('guard-release'));
  await adapter.releaseForRouting(async () => true);
  assert.equal(events.at(-1), 'guard-release');
});

test('Cell retries a signed route when its user guard exists only in kernel readback', async () => {
  let kernel = true;
  const owned = { ...guard([]),
    load: async () => ({ interfaces: [], pending: null }),
    current: async () => kernel ? { nftables: [] } : null };
  const adapter = new CellRuntimeAdapter({ server: server(), retainGuard: true,
    guard: owned, runtime: runtime(async () => {}) });
  assert.equal(await adapter.userGuardActive(), true);
  kernel = false;
  assert.equal(await adapter.userGuardActive(), false);
});

test('failed Docker forwarding leaves Cell traffic guarded', async () => {
  const events = [];
  const adapter = new CellRuntimeAdapter({ server: server(),
    runner: async file => { if (file === 'ip') throw missing(); return { stdout: '' }; },
    guard: guard(events), verifyRuntime: async () => true,
    dockerForwarding: { ensure: async () => { throw new Error('Docker chain changed'); } },
    runtime: runtime(async () => { events.push('apply'); }) });
  await assert.rejects(adapter.apply({ schema: 1, clients: [] }), /Docker chain changed/);
  assert.deepEqual(events, ['guard-recover', 'guard-protect', 'apply']);
});

test('runtime failure retains durable guard; invalid settings touch no system objects', async () => {
  const events = [];
  const adapter = new CellRuntimeAdapter({ server: server(),
    runner: async file => { events.push(file); if (file === 'ip') throw missing();
      return { stdout: '' }; },
    guard: guard(events), verifyRuntime: async () => true,
    runtime: runtime(async () => { events.push('apply'); throw new Error('apply failed'); }) });
  await assert.rejects(adapter.apply({ shell: 'anything' }));
  assert.deepEqual(events, []);
  await assert.rejects(adapter.apply({ schema: 1, clients: [] }), /apply failed/);
  assert.ok(events.includes('guard-protect'));
  assert.ok(!events.includes('guard-release'));
});

test('cell runtime refuses a foreign same-name guard without applying settings', async () => {
  const events = [];
  const adapter = new CellRuntimeAdapter({ server: server(),
    runner: async file => { if (file === 'ip') throw missing(); return { stdout: '' }; },
    guard: guard(events, { failRecover: true }), verifyRuntime: async () => true,
    runtime: runtime(async () => { events.push('apply'); }) });
  await assert.rejects(adapter.apply({ schema: 1, clients: [] }), /Foreign or changed/);
  assert.deepEqual(events, ['guard-recover']);
});

test('cell runtime refuses an existing policy table without saved cell policy', async () => {
  const events = [];
  const adapter = new CellRuntimeAdapter({ server: server(),
    runner: async file => { if (file === 'ip') throw missing(); return { stdout: '' }; },
    guard: guard(events), verifyRuntime: async () => true,
    runtime: { ...runtime(async () => { events.push('apply'); }),
      tableExists: async () => true } });
  await assert.rejects(adapter.apply({ schema: 1, clients: [] }),
    /no saved cell policy/);
  assert.deepEqual(events, ['guard-recover', 'guard-protect']);
});

test('cell runtime checks nft receipt before replacement and records readback before release', async () => {
  const events = [];
  const receipt = { assertKnown: async () => { events.push('receipt-check'); },
    recordCurrent: async () => { events.push('receipt-record'); },
    matchesCurrent: async () => { events.push('receipt-verify'); return true; } };
  const adapter = new CellRuntimeAdapter({ server: server(), policyReceipt: receipt,
    runner: async file => { if (file === 'ip') throw missing(); return { stdout: '' }; },
    guard: guard(events), verifyRuntime: async () => receipt.matchesCurrent(),
    runtime: runtime(async () => { events.push('apply'); }) });
  await adapter.apply({ schema: 1, clients: [] });
  assert.deepEqual(events, ['guard-recover', 'guard-protect', 'receipt-check',
    'apply', 'receipt-record', 'guard-release-start', 'receipt-verify', 'guard-release']);
  receipt.assertKnown = async () => { throw new Error('changed policy'); };
  events.length = 0;
  await assert.rejects(adapter.apply({ schema: 1, clients: [] }), /changed policy/);
  assert.deepEqual(events, ['guard-recover', 'guard-protect']);
});

test('failed post-apply verification keeps the guard for signed settings retry', async () => {
  const events = [];
  const adapter = new CellRuntimeAdapter({ server: server(),
    runner: async file => { if (file === 'ip') throw missing(); return { stdout: '' }; },
    guard: guard(events), verifyRuntime: async () => false,
    runtime: runtime(async () => { events.push('apply'); }) });
  await assert.rejects(adapter.apply({ schema: 1, clients: [] }), /Runtime not verified/);
  assert.ok(events.includes('apply'));
  assert.ok(!events.includes('guard-release'));
});

test('default verification compares persisted config, AWG readback and nft presence', async () => {
  const settings = { schema: 1, clients: [] }, localServer = server();
  const artifacts = buildCellArtifacts({ server: localServer, settings, geoDatabase: {} });
  const stripped = artifacts.serverConfig.split('\n')
    .filter(line => !line.startsWith('Address = ')).join('\n');
  const directory = path.resolve('/cell-test');
  let actual = stripped, nftPresent = true;
  const adapter = new CellRuntimeAdapter({ server: localServer,
    runtimeDirectory: directory, guard: guard([]),
    runtime: { runtimeDirectory: directory,
      readOptional: async file => file.endsWith('.conf') ? artifacts.serverConfig : artifacts.nftables,
      apply: async () => {} },
    runner: async (file, args) => {
      if (file === 'awg-quick') return { stdout: stripped };
      if (file === 'awg') return { stdout: actual };
      if (file === 'nft' && nftPresent) return { stdout: '' };
      throw missing();
    } });
  assert.equal(await adapter.verifyApplied(artifacts), true);
  actual = actual.replace('ListenPort = 12345', 'ListenPort = 12346');
  assert.equal(await adapter.verifyApplied(artifacts), false);
  actual = stripped; nftPresent = false;
  assert.equal(await adapter.verifyApplied(artifacts), false);
});
