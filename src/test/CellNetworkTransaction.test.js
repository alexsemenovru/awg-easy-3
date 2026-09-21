'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellNetworkTransaction, specification } = require('../lib/CellNetworkTransaction');
const { createAwgOwnership } = require('../lib/CellAwgOwnership');
const { routingPolicySnapshot } = require('../lib/CellNftPolicyJson');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-network-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const before = specification({ version: 1, devices: ['clients', 'transit'].map(interfaceName => ({ version: 1,
    owner: createAwgOwnership({ interfaceName, config: `[Interface]\nPrivateKey = ${Buffer.alloc(32, 8).toString('base64')}\nJc = 3\n` }), addresses: [] })),
    routing: { version: 1, interfaces: ['clients', 'transit'], commands: [],
      nftSnapshot: routingPolicySnapshot({ input: ['iifname "clients" drop'], forward: [], output: [], nat: [], sets: [] }) } });
  let after = structuredClone(before);
  after.devices.forEach(d => { d.owner.config = d.owner.config.replace('Jc = 3', 'Jc = 4'); });
  after.routing.nftSnapshot.nftables.find(x => x.rule).rule.comment = 'next revision';
  after = specification(after);
  const guard = { active: false, failRelease: false,
    async load() { return { interfaces: this.active ? ['clients', 'transit'] : [], pending: null }; },
    async recover() {}, async protect() { this.active = true; },
    async release(check) { assert.equal(await check(), true); if (this.failRelease) throw new Error('release failed'); this.active = false; },
  };
  const devices = new Map(before.devices.map(spec => [spec.owner.interfaceName,
    { state: { version: 1, phase: 'ready', spec: structuredClone(spec), blankHash: null }, actual: structuredClone(spec.owner), fail: false,
      async load() { return structuredClone(this.state); },
      async verify(candidate) { if (!equal(candidate.owner, this.actual)) throw new Error('Device drift'); return { up: true }; },
      async save(value) { assert.equal(guard.active, true); this.state = structuredClone(value); },
    }]));
  const routing = { guard, state: { committed: structuredClone(before.routing), pending: null }, fail: false,
    async load() { return structuredClone(this.state); },
    async verify(value) { return equal(this.state.committed, value); },
    async recover() { assert.equal(guard.active, true); this.state.pending = null; },
    async apply(value, options) {
      assert.equal(guard.active, true); assert.equal(options.retainGuard, true);
      this.state = { committed: structuredClone(value), pending: null };
      if (this.fail) { this.fail = false; throw new Error('after routing commit'); }
    },
  };
  const options = { directory, components: { routing, device: name => devices.get(name), awg: name => ({
    async reconcile(candidates, desired) {
      assert.equal(guard.active, true); const device = devices.get(name);
      if (!candidates.some(c => equal(c, device.actual))) throw new Error('Unexplained drift');
      device.actual = structuredClone(desired);
      if (device.fail) { device.fail = false; throw new Error('after setconf'); }
    },
  }) } };
  const tx = new CellNetworkTransaction(options);
  return { tx, fresh: () => new CellNetworkTransaction(options), directory, before, after, devices, routing, guard };
}
test('network commits every AWG/lifecycle/routing snapshot before releasing guard', async t => {
  const { tx, before, after, guard, devices } = await fixture(t);
  assert.deepEqual(await tx.initialize(before), { initialized: true, guarded: true });
  assert.equal(guard.active, true);
  assert.deepEqual(await tx.apply(after), { applied: true, guarded: false });
  assert.deepEqual((await tx.load()).committed, after);
  for (const d of after.devices) assert.deepEqual(devices.get(d.owner.interfaceName).state.spec, d);
});
test('AWG failure after mutation restores previous whole network, keeping protection', async t => {
  const { tx, before, after, devices, guard } = await fixture(t);
  await tx.initialize(before); devices.get('transit').fail = true;
  await assert.rejects(tx.apply(after), /previous version restored/);
  assert.equal(await tx.verify(before), true); assert.equal(guard.active, true);
  assert.equal((await tx.load()).pending, null);
});
test('routing child commit followed by failure rolls AWG and routing back together', async t => {
  const { tx, before, after, routing, guard } = await fixture(t);
  await tx.initialize(before); routing.fail = true;
  await assert.rejects(tx.apply(after), /previous version restored/);
  assert.equal(await tx.verify(before), true); assert.equal(guard.active, true);
});
test('new process recovers mixed child commitments from parent before/after intent', async t => {
  const { tx, fresh, before, after, devices, routing, guard } = await fixture(t);
  await tx.initialize(before); await tx.save({ version: 1, committed: before, pending: { desired: after } });
  devices.get('clients').actual = structuredClone(after.devices[0].owner);
  // One device committed, another never started; routing also committed first.
  devices.get('clients').state.spec = structuredClone(after.devices[0]);
  routing.state.committed = structuredClone(after.routing);
  await assert.rejects(tx.apply(after), /recovery required/);
  await fresh().recover(); assert.equal(await tx.verify(before), true); assert.equal(guard.active, true);
});
test('unknown actual AWG config is never overwritten and intent remains', async t => {
  const { tx, fresh, before, after, devices, guard } = await fixture(t);
  await tx.initialize(before); await tx.save({ version: 1, committed: before, pending: { desired: after } });
  devices.get('clients').actual.config += 'Jmin = 99\n';
  await assert.rejects(fresh().recover(), /Unexplained drift/);
  assert.ok((await tx.load()).pending); assert.equal(guard.active, true);
  assert.ok(devices.get('clients').actual.config.includes('Jmin = 99'));
});
test('identity, addresses and membership cannot change through config-only transaction', async t => {
  const { tx, before, after } = await fixture(t); await tx.initialize(before);
  for (const mutate of [s => { s.devices[0].addresses = ['10.8.0.1/24']; },
    s => { s.devices[0].owner.mtu = 1400; },
    s => { s.devices[0].owner.config = s.devices[0].owner.config.replace(Buffer.alloc(32, 8).toString('base64'), Buffer.alloc(32, 9).toString('base64')); }]) {
    const bad = structuredClone(after); mutate(bad); await assert.rejects(tx.apply(bad), /lifecycle transition/);
  }
});
test('failed parent final write restores last confirmed network', async t => {
  const { tx, before, after, guard } = await fixture(t); await tx.initialize(before);
  const save = tx.save.bind(tx);
  tx.save = value => !value.pending && equal(value.committed, after) ? Promise.reject(new Error('disk failure')) : save(value);
  await assert.rejects(tx.apply(after), /previous version restored/);
  assert.equal(await tx.verify(before), true); assert.equal(guard.active, true);
});
test('release failure retains new parent commitment rather than silently rolling back', async t => {
  const { tx, before, after, guard } = await fixture(t); await tx.initialize(before); guard.failRelease = true;
  await assert.rejects(tx.apply(after), /release failed/);
  assert.deepEqual((await tx.load()).committed, after); assert.equal(guard.active, true);
});
test('unrelated lifecycle journal and corrupt private journal fail closed', async t => {
  const { tx, fresh, before, devices, directory } = await fixture(t); await tx.initialize(before);
  devices.get('clients').state.spec.owner.config += 'Jmin = 99\n';
  await assert.rejects(fresh().recover(), /Unrelated lifecycle/);
  await fs.writeFile(path.join(directory, 'network.json'), '{"secret":"DO_NOT_PRINT" BROKEN', { mode: 0o600 });
  await assert.rejects(fresh().recover(), e => /Unreadable/.test(e.message) && !e.message.includes('DO_NOT_PRINT'));
});
