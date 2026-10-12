'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellRoutingGuard } = require('../lib/CellRoutingGuard');
const { routingGuardSnapshot } = require('../lib/CellNftOwnership');
async function fixture(t, table) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-guard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const kernel = { current: null, writes: 0, fail: false };
  const runner = async (file, args, options) => {
    assert.equal(file, 'nft');
    if (args.includes('list')) return { stdout: JSON.stringify(args.at(-1) === 'tables'
      ? { nftables: kernel.current ? [kernel.current.nftables[0]] : [] } : kernel.current) };
    if (args.includes('-c')) return { stdout: '' };
    if (kernel.fail) throw new Error('injected nft failure');
    kernel.writes++;
    const batch = JSON.parse(options.input).nftables;
    const objects = batch.filter(x => x.add).map(x => x.add);
    kernel.current = objects.length ? { nftables: objects } : null;
    return { stdout: '' };
  };
  const options = { journalPath: path.join(dir, 'guard.json'), runner,
    ...(table ? { table } : {}) };
  return { guard: new CellRoutingGuard(options), fresh: () => new CellRoutingGuard(options), kernel, file: options.journalPath };
}
test('cell traffic guard retains its own table and journal across restart', async t => {
  const { guard, fresh, kernel } = await fixture(t, 'awg_easy_3_cell_guard');
  await guard.protect(['awg0']);
  assert.equal(kernel.current.nftables[0].table.name, 'awg_easy_3_cell_guard');
  assert.deepEqual((await fresh().recover()).interfaces, ['awg0']);
  await fresh().release(async () => true);
  assert.equal(kernel.current, null);
});
test('durable guard grows protection, requires explicit verified release, survives restart', async t => {
  const { guard, fresh, kernel } = await fixture(t);
  await guard.protect(['clients']); await guard.protect(['transit']);
  assert.deepEqual((await fresh().recover()).interfaces, ['clients', 'transit']);
  await assert.rejects(guard.release(async () => false), /not verified/);
  assert.ok(kernel.current);
  await guard.release(async () => true); assert.equal(kernel.current, null);
  assert.deepEqual(await fresh().recover(), { guarded: false, interfaces: [] });
});
test('same-name foreign guard is not adopted and kernel errors do not mean absence', async t => {
  const { guard, kernel } = await fixture(t);
  kernel.current = routingGuardSnapshot(['clients']);
  await assert.rejects(guard.protect(['clients']), /Foreign/);
  assert.equal(kernel.writes, 0);
  guard.runner = async () => { throw new Error('permission denied'); };
  await assert.rejects(guard.protect(['clients']), /permission/);
});
test('interrupted initial protection recovers whether kernel apply happened or not', async t => {
  const { guard, fresh, kernel } = await fixture(t);
  const intent = { version: 1, interfaces: [], pending: { kind: 'protect', interfaces: ['clients'] } };
  for (const applied of [false, true]) {
    await guard.save(intent); kernel.current = applied ? routingGuardSnapshot(['clients']) : null;
    await assert.rejects(guard.protect(['transit']), /requires recovery/);
    assert.equal((await fresh().recover()).guarded, true);
    assert.ok(kernel.current); assert.equal((await guard.load()).pending, null);
  }
});
test('interrupted extension never loses the old protected interfaces', async t => {
  const { guard, fresh, kernel } = await fixture(t);
  await guard.protect(['old']);
  await guard.save({ version: 1, interfaces: ['old'], pending: { kind: 'protect', interfaces: ['new', 'old'] } });
  await fresh().recover();
  assert.deepEqual(kernel.current, routingGuardSnapshot(['old', 'new']));
  await assert.rejects(guard.save({ version: 1, interfaces: ['old'], pending: { kind: 'protect', interfaces: ['new'] } }), /Invalid/);
});
test('interrupted release reinstates protection after deletion, not unrestricted operation', async t => {
  const { guard, fresh, kernel } = await fixture(t);
  await guard.protect(['clients']);
  await guard.save({ version: 1, interfaces: ['clients'], pending: { kind: 'release' } });
  kernel.current = null;
  assert.equal((await fresh().recover()).guarded, true);
  assert.ok(kernel.current);
});
test('failed release persistence restores guard and reports failure', async t => {
  const { guard, kernel } = await fixture(t);
  await guard.protect(['clients']);
  const save = guard.save.bind(guard);
  guard.save = async value => {
    if (!value.interfaces.length) throw new Error('disk failure');
    return save(value);
  };
  await assert.rejects(guard.release(async () => true), /disk failure/);
  assert.ok(kernel.current); assert.equal((await guard.load()).pending, null);
});
test('nft failure retains durable intent; changed rules stop recovery without deletion', async t => {
  const { guard, fresh, kernel } = await fixture(t);
  kernel.fail = true; await assert.rejects(guard.protect(['clients']), /injected/);
  assert.equal((await guard.load()).pending.kind, 'protect');
  kernel.fail = false; await fresh().recover();
  kernel.current.nftables.at(-1).rule.expr = [{ accept: null }];
  const writes = kernel.writes;
  await assert.rejects(fresh().recover(), /Foreign/); assert.equal(kernel.writes, writes);
});
test('corrupt journal and missing guard during release fail safely', async t => {
  const { guard, kernel, file } = await fixture(t);
  await guard.protect(['clients']); kernel.current = null;
  await assert.rejects(guard.release(async () => { assert.ok(kernel.current); throw new Error('runtime broken'); }), /runtime broken/);
  assert.ok(kernel.current);
  await fs.writeFile(file, '{bad');
  const writes = kernel.writes; await assert.rejects(guard.recover()); assert.equal(kernel.writes, writes);
});
test('same-process guard instances serialize and snapshot caller interfaces', async t => {
  const { guard, fresh } = await fixture(t);
  const a = ['a']; const first = guard.protect(a); a[0] = 'unexpected';
  await Promise.all([first, fresh().protect(['b'])]);
  assert.deepEqual((await guard.load()).interfaces, ['a', 'b']);
});
test('malformed nft inventory is not treated as an empty firewall', async t => {
  const { guard } = await fixture(t);
  for (const reply of [{}, { nftables: [{}] }, { nftables: [{ table: { name: 'anything' } }] }]) {
    guard.runner = async () => ({ stdout: JSON.stringify(reply) });
    await assert.rejects(guard.protect(['clients']), /Invalid nft inventory/);
    assert.equal((await guard.load()).pending, null);
  }
});
test('Linux guard journal rejects public permissions and symbolic links', { skip: process.platform === 'win32' }, async t => {
  const { guard, file, kernel } = await fixture(t);
  await guard.protect(['clients']);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.chmod(file, 0o644); await assert.rejects(guard.recover(), /Unsafe/);
  await fs.chmod(file, 0o600); await fs.rename(file, `${file}.real`);
  await fs.symlink(`${file}.real`, file);
  const writes = kernel.writes;
  await assert.rejects(guard.recover(), /Unsafe/); assert.equal(kernel.writes, writes);
});
test('Linux guard journal rejects hard links and a public state directory', { skip: process.platform === 'win32' }, async t => {
  const { guard, file, kernel } = await fixture(t);
  await guard.protect(['clients']);
  const alias = `${file}.alias`;
  await fs.link(file, alias);
  const writes = kernel.writes;
  await assert.rejects(guard.recover(), /Unsafe/);
  assert.equal(kernel.writes, writes);
  await fs.unlink(alias);
  await fs.chmod(path.dirname(file), 0o755);
  await assert.rejects(guard.save({ version: 1, interfaces: ['clients'], pending: null }),
    /Private guard journal directory required/);
});
