'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellRoutingCoordinator } = require('../lib/CellRoutingCoordinator');
const { routingPolicySnapshot } = require('../lib/CellNftPolicyJson');
const spec = n => ({ version: 1, interfaces: ['clients', 'transit'],
  commands: [{ file: 'ip', args: ['-4', 'route', 'add', 'unreachable', 'default', 'table', String(52000 + n), 'proto', '186', 'metric', '32767'] }],
  nftSnapshot: routingPolicySnapshot({ input: [`iifname "${n ? 'transit' : 'clients'}" drop`], forward: [], output: [], nat: [], sets: [] }) });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-coordinator-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const guard = { interfaces: [], pending: null, active: false, failRelease: false,
    async load() { return { interfaces: [...this.interfaces], pending: this.pending }; },
    async current() { return this.active ? { nftables: [] } : null; },
    async recover() { return { guarded: this.active }; },
    async protect(names) { this.interfaces = [...names]; this.active = true; },
    async release(verify) {
      if (this.failRelease || await verify() !== true) throw new Error('release refused');
      this.active = false; this.interfaces = [];
    } };
  function child(initial) { return {
    state: { committed: initial, pending: null }, fail: false,
    async load() { return structuredClone(this.state); },
    async apply(value) {
      assert.equal(guard.active, true);
      if (this.fail) { this.fail = false; throw new Error('child apply failed'); }
      this.state = { committed: structuredClone(value), pending: null };
    },
    async recover() { assert.equal(guard.active, true); this.state.pending = null; },
  }; }
  const routes = child([]), policy = child(null);
  routes.inventory = async () => ({ routes4: routes.state.committed.map(command => ({ dst: 'default', type: 'unreachable',
    table: Number(command.args[6]), protocol: 'bgp', metric: 32767 })), routes6: [], rules4: [], rules6: [] });
  policy.plan = async (allowed, desired) => ({ changed: JSON.stringify(policy.state.committed) !== JSON.stringify(desired) });
  const verification = { valid: true };
  const options = { directory, verifyInterfaces: async () => verification.valid, components: { guard, routes, policy } };
  return { coordinator: new CellRoutingCoordinator(options), fresh: () => new CellRoutingCoordinator(options), guard, routes, policy, verification };
}
test('coordinator commits matching policy/routes before releasing guard', async t => {
  const { coordinator, guard, routes, policy } = await fixture(t);
  assert.equal((await coordinator.apply(spec(0))).applied, true);
  await coordinator.apply(spec(1));
  assert.equal(guard.active, false);
  assert.deepEqual(routes.state.committed, spec(1).commands);
  assert.deepEqual(policy.state.committed, spec(1).nftSnapshot);
  assert.deepEqual((await coordinator.load()).committed, spec(1));
});

test('parent AWG transaction can retain protection after routing commitment', async t => {
  const { coordinator, guard } = await fixture(t);
  assert.deepEqual(await coordinator.apply(spec(0), { retainGuard: true }), { applied: true, guarded: true });
  assert.equal(guard.active, true); assert.equal(await coordinator.verify(spec(0)), true);
  assert.throws(() => coordinator.apply(spec(1), { retainGuard: 'yes' }), /retention/);
});
test('retained routing guard releases only after committed readback remains valid', async t => {
  const { coordinator, guard, verification, policy } = await fixture(t);
  await assert.rejects(coordinator.releaseCommitted(), /No committed/);
  await coordinator.apply(spec(0), { retainGuard: true });
  verification.valid = false;
  await assert.rejects(coordinator.releaseCommitted(), /not verified/);
  assert.equal(guard.active, true);
  verification.valid = true;
  policy.state.committed = spec(1).nftSnapshot;
  await assert.rejects(coordinator.releaseCommitted(), /disagrees/);
  assert.equal(guard.active, true);
  policy.state.committed = spec(0).nftSnapshot;
  assert.deepEqual(await coordinator.releaseCommitted(), { guarded: false });
  assert.equal(guard.active, false);
  assert.equal(await coordinator.verifyOperational(spec(0)), true);
  guard.active = true; guard.interfaces = ['clients', 'transit'];
  assert.equal(await coordinator.verifyOperational(spec(0)), false);
});
test('route failure after new policy restores both old components, guard retained', async t => {
  const { coordinator, guard, routes, policy } = await fixture(t);
  await coordinator.apply(spec(0)); routes.fail = true;
  await assert.rejects(coordinator.apply(spec(1)), /child apply failed/);
  assert.equal(guard.active, true);
  assert.deepEqual(routes.state.committed, spec(0).commands);
  assert.deepEqual(policy.state.committed, spec(0).nftSnapshot);
  assert.equal((await coordinator.load()).pending, null);
});
test('restart after one child committed restores the parent snapshot, not the mixed child states', async t => {
  const { coordinator, fresh, guard, policy, routes } = await fixture(t);
  await coordinator.apply(spec(0));
  await coordinator.save({ version: 1, committed: spec(0), pending: { desired: spec(1) } });
  policy.state.committed = spec(1).nftSnapshot;
  await assert.rejects(coordinator.apply(spec(1)), /requires recovery/);
  await fresh().recover();
  assert.deepEqual(policy.state.committed, spec(0).nftSnapshot); assert.deepEqual(routes.state.committed, spec(0).commands);
  assert.equal(guard.active, true);
  await fresh().apply(spec(0)); assert.equal(guard.active, false);
});
test('interrupted initial install removes partial child state but retains protection', async t => {
  const { coordinator, guard, policy, routes } = await fixture(t);
  await coordinator.save({ version: 1, committed: null, pending: { desired: spec(0) } });
  policy.state.committed = spec(0).nftSnapshot;
  assert.deepEqual(await coordinator.recover(), { restored: false, guarded: true });
  assert.equal(policy.state.committed, null); assert.deepEqual(routes.state.committed, []); assert.equal(guard.active, true);
});
test('unrelated child journal or lost interface verification never enables traffic', async t => {
  const { coordinator, guard, policy, verification } = await fixture(t);
  await coordinator.apply(spec(0)); policy.state.committed = spec(1).nftSnapshot;
  await assert.rejects(coordinator.recover(), /disagrees/); assert.equal(guard.active, true);
  verification.valid = false;
  await assert.rejects(coordinator.apply(spec(0)), /not verified/);
});
test('interface membership changes and orphaned protection require lifecycle management', async t => {
  const { coordinator, guard } = await fixture(t);
  await coordinator.apply(spec(0));
  await assert.rejects(coordinator.apply({ ...spec(0), interfaces: ['clients', 'transit', 'extra'] }), /lifecycle/);
  guard.interfaces = ['orphan']; guard.active = true;
  await assert.rejects(coordinator.apply(spec(0)), /lifecycle/); assert.equal(guard.active, true);
});
test('guard release failure preserves newly committed parent, never rolls back its journal', async t => {
  const { coordinator, guard, policy } = await fixture(t);
  await coordinator.apply(spec(0)); guard.failRelease = true;
  await assert.rejects(coordinator.apply(spec(1)), /release refused/);
  assert.deepEqual((await coordinator.load()).committed, spec(1));
  assert.deepEqual(policy.state.committed, spec(1).nftSnapshot); assert.equal(guard.active, true);
});
test('parent persistence failure rolls both children back before clearing intent', async t => {
  const { coordinator, guard, routes, policy } = await fixture(t);
  await coordinator.apply(spec(0));
  const save = coordinator.save.bind(coordinator);
  coordinator.save = async value => {
    if (!value.pending && JSON.stringify(value.committed) === JSON.stringify(spec(1))) throw new Error('parent disk failure');
    return save(value);
  };
  await assert.rejects(coordinator.apply(spec(1)), /parent disk failure/);
  assert.deepEqual(routes.state.committed, spec(0).commands); assert.deepEqual(policy.state.committed, spec(0).nftSnapshot);
  assert.deepEqual((await coordinator.load()).committed, spec(0)); assert.equal(guard.active, true);
});
test('route references outside protected interfaces are rejected before writes', async t => {
  const { coordinator, guard } = await fixture(t);
  const bad = spec(0);
  bad.commands = [{ file: 'ip', args: ['-4', 'route', 'add', '10.88.0.2/32', 'table', 'main', 'proto', '186', 'dev', 'foreign'] }];
  assert.throws(() => coordinator.apply(bad), /unmanaged/); assert.equal(guard.active, false);
  assert.equal((await coordinator.load()).committed, null);
});
