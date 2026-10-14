'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellNftTransaction } = require('../lib/CellNftTransaction');
const { routingPolicySnapshot } = require('../lib/CellNftPolicyJson');
const policy = name => routingPolicySnapshot({ input: [`iifname "${name}" drop`], forward: [], output: [], nat: [], sets: [] });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-nft-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const kernel = { current: null, writes: 0, failNext: false, guard: false };
  const options = { journalPath: path.join(dir, 'nft.json'), activateGuard: async () => { kernel.guard = true; },
    runner: async (file, args, options) => {
      assert.equal(file, 'nft');
      if (args.includes('list')) return { stdout: JSON.stringify(args.at(-1) === 'tables'
        ? { nftables: kernel.current ? [kernel.current.nftables[0]] : [] } : kernel.current) };
      assert.equal(kernel.guard, true);
      if (args.includes('-c')) return { stdout: '' };
      if (kernel.failNext) { kernel.failNext = false; throw new Error('nft rejected transaction'); }
      const objects = JSON.parse(await fs.readFile(args.at(-1), 'utf8')).nftables.filter(x => x.add).map(x => x.add);
      kernel.current = objects.length ? { nftables: objects } : null; kernel.writes++;
      return { stdout: '' };
    } };
  return { tx: new CellNftTransaction(options), fresh: () => new CellNftTransaction(options), kernel };
}
test('nft transaction persists before/after, validates readback, never releases guard', async t => {
  const { tx, fresh, kernel } = await fixture(t);
  await tx.apply(policy('one')); assert.equal(kernel.guard, true);
  const writes = kernel.writes; await fresh().apply(policy('one')); assert.equal(kernel.writes, writes);
  await tx.apply(policy('two')); assert.deepEqual((await tx.load()).committed, policy('two'));
  await tx.apply(null); assert.equal(kernel.current, null); assert.equal(kernel.guard, true);
});
test('foreign policy is not adopted or overwritten', async t => {
  const { tx, kernel } = await fixture(t); kernel.current = policy('one');
  await assert.rejects(tx.apply(policy('one')), /Foreign/); assert.equal(kernel.writes, 0);
  await assert.rejects(tx.recover(), /Foreign/); assert.equal(kernel.guard, true);
});
test('atomic nft failure rolls back while retaining protection', async t => {
  const { tx, kernel } = await fixture(t);
  await tx.apply(policy('one')); kernel.failNext = true;
  await assert.rejects(tx.apply(policy('two')), /rejected/);
  assert.deepEqual(kernel.current, policy('one')); assert.equal((await tx.load()).pending, null);
  assert.equal(kernel.guard, true);
});
test('interrupted before/after/missing policy recovers last committed snapshot', async t => {
  const { tx, fresh, kernel } = await fixture(t);
  for (const actual of [policy('one'), policy('two'), null]) {
    await tx.save({ version: 1, committed: policy('one'), pending: { desired: policy('two') } });
    kernel.current = actual;
    await assert.rejects(tx.apply(policy('two')), /requires recovery/);
    await fresh().recover(); assert.deepEqual(kernel.current, policy('one'));
  }
  await tx.save({ version: 1, committed: null, pending: { desired: policy('one') } });
  kernel.current = policy('one'); await fresh().recover(); assert.equal(kernel.current, null);
});
test('failed persistence after apply restores previous policy', async t => {
  const { tx, kernel } = await fixture(t); await tx.apply(policy('one'));
  const save = tx.save.bind(tx);
  tx.save = async value => {
    if (!value.pending && JSON.stringify(value.committed) === JSON.stringify(policy('two'))) throw new Error('disk failed');
    return save(value);
  };
  await assert.rejects(tx.apply(policy('two')), /disk failed/);
  assert.deepEqual(kernel.current, policy('one')); assert.equal(kernel.guard, true);
});
test('drift during interrupted apply preserves foreign rules and pending evidence', async t => {
  const { tx, kernel } = await fixture(t);
  await tx.save({ version: 1, committed: policy('one'), pending: { desired: policy('two') } });
  kernel.current = policy('foreign');
  await assert.rejects(tx.recover(), /Foreign/);
  assert.ok((await tx.load()).pending); assert.equal(kernel.writes, 0); assert.equal(kernel.guard, true);
});
test('guard activation failure never mutates policy or journal', async t => {
  const { tx, kernel } = await fixture(t);
  tx.activateGuard = async () => { throw new Error('guard failed'); };
  await assert.rejects(tx.apply(policy('one')), /guard failed/);
  assert.equal(kernel.writes, 0); assert.equal((await tx.load()).pending, null);
});
test('corrupt nft journal rejects recovery and caller snapshot is not retained by reference', async t => {
  const { tx } = await fixture(t);
  const desired = policy('one'); const pending = tx.apply(desired); desired.nftables = [];
  await pending; assert.deepEqual((await tx.load()).committed, policy('one'));
  await fs.writeFile(tx.file, '{bad'); await assert.rejects(tx.recover());
});
