'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { identity } = require('../lib/CellRegistration');
const { createRecoveryMaterial, signBackupGrant, signTakeover } = require('../lib/BackupRecovery');
const { CellBackupRecoveryStore } = require('../lib/CellBackupRecoveryStore');
const { createRestoredEndpoint } = require('../lib/CellRestoredEndpoint');
async function fixture(t, endpointHost = '198.51.100.20') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-restored-endpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const main = identity(), cell = identity(), authority = identity();
  const trust = { controllerKey: main.publicKey, cellKey: cell.publicKey, status: 'registered' };
  const recovery = new CellBackupRecoveryStore(path.join(directory, 'backup-recovery.json'), trust);
  const material = createRecoveryMaterial(1);
  const grant = signBackupGrant(material, Buffer.from('synthetic encrypted backup'), main.privateKey);
  await recovery.accept(grant);
  const challenge = await recovery.challenge();
  await recovery.consume(signTakeover({ grant, material, cellKey: cell.publicKey,
    challenge: challenge.nonce, authorityKey: authority.publicKey, endpointHost }));
  const key = () => crypto.randomBytes(32).toString('base64');
  const plan = (name, port) => ({ spec: { owner: { interfaceName: name,
    ownerTag: `awg-easy-3-cell:${crypto.randomUUID()}`, config: `[Interface]\nPrivateKey=${key()}\n`
      + `[Peer]\nPublicKey=${key()}\nAllowedIPs=10.91.0.1/32\nEndpoint=198.51.100.10:${port}\n` } } });
  const control = plan('restorec0', 53084), data = plan('restored0', 53000);
  const kernel = new Map(), calls = [];
  let controlPort = 54001, owned = true, guards = 0, resolutions = 0;
  const runner = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'awg') return { stdout: `${args[1] === 'restorec0' ? controlPort : 54002}\n` };
    if (file === 'ip') return { stdout: JSON.stringify([{ dst: args.at(-1), prefsrc: '192.0.2.10' }]) };
    if (file === 'conntrack') return { stdout: '', stderr: '' };
    if (file !== 'nft') throw new Error('Unexpected host mutation');
    if (args.join(' ') === '-j list tables') return { stdout: JSON.stringify({ nftables: [...kernel.values()].map(value => value.nftables[0]) }) };
    if (args.slice(0, 4).join(' ') === '-j list table ip') return { stdout: JSON.stringify(kernel.get(args[4])) };
    if (args[0] === '-c') return { stdout: '' };
    if (args[0] === '-j' && args[1] === '-f') {
      const batch = JSON.parse(await fs.readFile(args[2], 'utf8'));
      const value = { nftables: batch.nftables.map(item => item.add) };
      kernel.set(value.nftables[0].table.name, value);
      return { stdout: '' };
    }
    if (args.slice(0, 3).join(' ') === 'delete table ip') { kernel.delete(args[3]); return { stdout: '' }; }
    throw new Error('Unexpected nft mutation');
  };
  const options = { stateDirectory: directory, connectionStore: { filePath: path.join(directory, 'connection.json'), read: async () => trust },
    permanentPlanStore: { read: async () => control }, dataDeployment: { stateDirectory: path.join(directory, 'data-link'),
      store: { read: async () => data }, policyTable: 'awg_easy_3_data_cell', guardTable: 'awg_easy_3_data_guard_cell' },
    runner, buildPath: ({ plan }) => ({ interfaceName: plan.spec.owner.interfaceName, verifyOwned: async () => owned }),
    resolve: async () => { resolutions++; return [{ family: 4, address: '198.51.100.20' }]; } };
  return { options, kernel, calls, migration: createRestoredEndpoint(options), protect: async () => { guards++; },
    guards: () => guards, resolutions: () => resolutions, setPort: port => { controlPort = port; }, setOwned: value => { owned = value; } };
}
test('restored endpoint changes only exact owned control/data UDP destinations and is stable across polls and rebooted sockets', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.migration.ensure({ protect: f.protect }), { migrated: true, changed: true });
  assert.equal(f.guards(), 1);
  assert.equal(f.kernel.size, 2);
  for (const value of f.kernel.values()) {
    const text = JSON.stringify(value);
    assert.match(text, /"prio":-90/);
    assert.match(text, /"dnat":\{"addr":"198\.51\.100\.20"/);
    assert.match(text, /"saddr"/); assert.match(text, /"sport"/); assert.match(text, /"dport"/);
    assert.doesNotMatch(text, /redirect|masquerade|forward|flush/);
  }
  assert.deepEqual(await f.migration.ensure({ protect: f.protect }), { migrated: true, changed: false });
  assert.equal(f.guards(), 1);
  f.setPort(54003);
  await f.migration.ensure({ protect: f.protect });
  assert.equal(f.guards(), 2);
  assert.match(JSON.stringify(f.kernel.get('awg_easy_3_restore_control')), /54003/);
  assert.equal(f.calls.some(call => call[0] === 'awg' && call[1] !== 'show'), false);
  await f.migration.close({ protect: f.protect });
  assert.equal(f.kernel.size, 0);
  assert.equal(f.guards(), 3);
});
test('restored endpoint refuses changed ownership or externally modified NAT and retains the traffic guard', async t => {
  const f = await fixture(t);
  f.setOwned(false);
  await assert.rejects(f.migration.ensure({ protect: f.protect }), /ownership/);
  assert.equal(f.kernel.size, 0);
  assert.equal(f.guards(), 1);
  f.setOwned(true);
  await f.migration.ensure({ protect: f.protect });
  const table = f.kernel.get('awg_easy_3_restore_data');
  table.nftables[2].rule.expr.push({ counter: { packets: 1, bytes: 100 } });
  await assert.rejects(f.migration.ensure({ protect: f.protect }), /changed externally/);
  assert.equal(f.kernel.get('awg_easy_3_restore_data'), table);
  assert.ok(f.guards() >= 3);
});
test('DNS resolution is pinned to the signed takeover proof across process restarts', async t => {
  const f = await fixture(t, 'new.example.test');
  await f.migration.ensure({ protect: f.protect });
  assert.equal(f.resolutions(), 1);
  const restarted = createRestoredEndpoint({ ...f.options, resolve: async () => { throw new Error('Unexpected DNS change'); } });
  assert.deepEqual(await restarted.ensure({ protect: f.protect }), { migrated: true, changed: false });
});
