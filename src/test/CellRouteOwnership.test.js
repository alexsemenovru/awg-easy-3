'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { manifest, planRouteChanges } = require('../lib/CellRouteOwnership');
const { CellRouteTransaction } = require('../lib/CellRouteTransaction');
const command = args => ({ file: 'ip', args: args.split(' ') });
const routes = [command('-4 route add unreachable default table 52000 proto 186 metric 32767'),
  command('-4 route add default table 52000 proto 186 dev transit metric 100'),
  command('-6 route add fd88::3/128 table main proto 186 dev transit'),
  command('-4 rule add pref 20000 iif clients from 10.88.0.2/32 lookup 52000')];
const empty = () => ({ routes4: [], routes6: [], rules4: [], rules6: [] });
function row(command) {
  const r = manifest([command])[0].record, a = command.args;
  return r.kind === 'route'
    ? { dst: a[r.type === 'unreachable' ? 4 : 3], table: r.table, type: r.type, ...(r.dev ? { dev: r.dev } : {}), metric: r.metric, protocol: 186 }
    : { priority: r.priority, src: a[a.indexOf('from') + 1], iif: r.iif, table: r.table };
}
function inventory(commands) {
  const result = empty();
  for (const command of commands) { const r = manifest([command])[0].record; result[`${r.kind}s${r.family}`].push(row(command)); }
  return result;
}
test('first install does not adopt even exact existing routes without ownership journal', () => {
  assert.throws(() => planRouteChanges({ desired: routes, inventory: inventory(routes) }), /foreign/);
  assert.equal(planRouteChanges({ desired: routes, inventory: empty() }).add.length, 4);
});
test('owned reconciliation is idempotent and restores only disappeared routes', () => {
  assert.deepEqual(planRouteChanges({ previous: routes, desired: routes, inventory: inventory(routes) }).add, []);
  const missing = inventory(routes); missing.routes4.pop();
  assert.deepEqual(planRouteChanges({ previous: routes, desired: routes, inventory: missing }).add, [routes[1]]);
});
test('kernel symbolic protocol bgp means 186 but never grants ownership by itself', () => {
  const s = inventory(routes); s.routes4.forEach(r => { r.protocol = 'bgp'; });
  assert.equal(planRouteChanges({ previous: routes, desired: routes, inventory: s }).add.length, 0);
  assert.throws(() => planRouteChanges({ desired: routes, inventory: s }), /foreign/);
});
test('IPv6 unreachable uses kernel loopback presentation, never a forwarding device', () => {
  const commands = [command('-6 route add unreachable default table 52000 proto 186 metric 32767')];
  const s = inventory(commands); s.routes6[0].dev = 'lo';
  assert.equal(planRouteChanges({ previous: commands, desired: commands, inventory: s }).add.length, 0);
  s.routes6[0].dev = 'transit';
  assert.throws(() => planRouteChanges({ previous: commands, desired: commands, inventory: s }), /foreign/);
});
test('reject foreign routes anywhere in reserved table and selectors at another priority', () => {
  for (const change of [s => s.routes4.push({ dst: '192.0.2.0/24', table: 52000, dev: 'other', protocol: 'static' }),
    s => s.rules4.push({ priority: 123, src: 'all', table: 52000 }),
    s => s.routes6[0].gateway = 'fd88::1', s => s.routes4[1].protocol = 'static']) {
    const s = inventory(routes); change(s);
    assert.throws(() => planRouteChanges({ previous: routes, desired: routes, inventory: s }));
  }
});
test('unrelated routes and host default survive; stale rules removed before routes', () => {
  const s = inventory(routes); s.routes4.push({ dst: 'default', gateway: '192.0.2.1', protocol: 'dhcp' });
  const p = planRouteChanges({ previous: routes, desired: [], inventory: s });
  assert.equal(p.remove.length, 4); assert.equal(p.remove[0].args[1], 'rule');
  assert.ok(p.remove.every(c => c.args[2] === 'del'));
});
test('canonical IPv6 matches kernel spelling; unknown attributes and duplicate objects reject', () => {
  const s = inventory(routes); s.routes6[0].dst = 'fd88:0:0:0:0:0:0:3';
  assert.equal(planRouteChanges({ previous: routes, desired: routes, inventory: s }).add.length, 0);
  s.routes6[0].encap = 'unexpected';
  assert.throws(() => planRouteChanges({ previous: routes, desired: routes, inventory: s }));
  assert.throws(() => manifest([routes[0], routes[0]]), /duplicate/);
});
test('reject arbitrary commands, broad selectors, replacement and host default', () => {
  for (const args of ['-4 route replace default table 52000 proto 186 dev transit',
    '-4 route add default table main proto 186 dev transit', '-4 route flush table main',
    '-4 rule add pref 20000 iif clients from all lookup 52000',
    '-4 route add 10.0.0.0/8 table main proto 186 dev transit',
    '-4 rule add pref 100 iif clients from 10.88.0.2 lookup 52000']) assert.throws(() => manifest([command(args)]));
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-route-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kernel = empty(), calls = []; let fault = null, countdown = 0, guard = false;
  const runner = async (file, args) => {
    calls.push([file, ...args]); const family = args[0] === '-4' ? 4 : 6;
    if (args[1] === '-j') return { stdout: JSON.stringify(kernel[`${args[2]}s${family}`]) };
    assert.equal(guard, true, 'mutation before guard');
    if (fault && countdown-- === 0) { const f = fault; fault = null; throw f; }
    const copy = { file, args: args.map((s, i) => i === 2 ? 'add' : s) };
    const items = kernel[`${args[1]}s${family}`], object = row(copy);
    if (args[2] === 'add') items.push(object);
    else { const index = items.findIndex(x => JSON.stringify(x) === JSON.stringify(object)); assert.ok(index >= 0); items.splice(index, 1); }
    return { stdout: '' };
  };
  const tx = new CellRouteTransaction({ journalPath: path.join(directory, 'routes.json'), runner,
    activateGuard: async () => { guard = true; } });
  return { tx, kernel, calls, runner, fail: (after = 0) => { fault = new Error('injected'); countdown = after; } };
}
test('transaction persists ownership, repairs vanished routes, keeps guard enabled', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.tx.apply(routes), { added: 4, removed: 0, guarded: true });
  assert.equal((await f.tx.apply(routes)).added, 0);
  f.kernel.routes4.pop(); assert.equal((await f.tx.recover()).added, 1);
  assert.equal((await f.tx.load()).pending, null);
});
test('failed change rolls routes back and does not mark desired as committed', async t => {
  const f = await fixture(t); await f.tx.apply(routes); f.fail();
  await assert.rejects(f.tx.apply([]), /injected/);
  assert.deepEqual((await f.tx.load()).committed, routes);
  assert.deepEqual(planRouteChanges({ previous: routes, desired: routes, inventory: f.kernel }).add, []);
});
test('failure after partial deletion restores all old routes under guard', async t => {
  const f = await fixture(t); await f.tx.apply(routes); f.fail(2);
  await assert.rejects(f.tx.apply([]), /injected/);
  assert.deepEqual((await f.tx.load()).committed, routes);
  assert.equal(planRouteChanges({ previous: routes, desired: routes, inventory: f.kernel }).add.length, 0);
});
test('a failed guard causes no route mutation and creates no journal', async t => {
  const f = await fixture(t);
  f.tx.activateGuard = async () => { throw new Error('guard failed'); };
  await assert.rejects(f.tx.apply(routes), /guard failed/);
  assert.equal(f.calls.filter(c => c[2] !== '-j').length, 0);
  await assert.rejects(fs.stat(f.tx.file), { code: 'ENOENT' });
});
test('crash recovery reverts exact pending objects; foreign drift leaves pending and guard', async t => {
  const f = await fixture(t); await f.tx.apply(routes);
  const next = command('-4 route add 10.88.0.9/32 table main proto 186 dev transit');
  await f.tx.save({ version: 1, committed: routes, pending: { desired: [...routes, next] } });
  f.kernel.routes4.push(row(next));
  await assert.rejects(f.tx.apply(routes), /requires recovery/);
  assert.equal((await f.tx.recover()).removed, 1);
  await f.tx.save({ version: 1, committed: routes, pending: { desired: [...routes, next] } });
  f.kernel.routes4.push({ ...row(next), dev: 'foreign' });
  await assert.rejects(f.tx.recover(), /foreign/); assert.ok((await f.tx.load()).pending);
});
test('corrupt journal is not replaced and concurrent instances serialize', async t => {
  const f = await fixture(t);
  const other = new CellRouteTransaction({ journalPath: f.tx.file, runner: f.runner, activateGuard: f.tx.activateGuard });
  await Promise.all([f.tx.apply(routes), other.apply(routes)]);
  assert.equal(f.calls.filter(c => c[3] === 'add').length, 4);
  await fs.writeFile(f.tx.file, '{broken');
  await assert.rejects(f.tx.recover()); assert.equal(await fs.readFile(f.tx.file, 'utf8'), '{broken');
});
