'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CellAwgTransaction } = require('../lib/CellAwgTransaction');
const { createAwgOwnership } = require('../lib/CellAwgOwnership');
const secret = Buffer.alloc(32, 7).toString('base64');
const config = `[Interface]\nPrivateKey = ${secret}\nListenPort = 54322\nJc = 3\n`;
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-awg-tx-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const owner = createAwgOwnership({ interfaceName: 'transit', config });
  const kernel = { config, guard: false, writes: 0, failure: null,
    links: [{ ifname: 'transit', ifalias: owner.ownerTag, mtu: 1280, flags: ['UP'],
      linkinfo: { info_kind: 'tun', info_data: { type: 'tun' } } }] };
  const opts = { journalPath: path.join(dir, 'awg.json'), activateGuard: async names => {
    assert.deepEqual(names, ['transit']); kernel.guard = true;
  }, runner: async (file, args) => {
    if (file === 'ip') return { stdout: JSON.stringify(kernel.links) };
    assert.equal(file, 'awg');
    if (args[0] === 'showconf') return { stdout: kernel.config };
    assert.deepEqual(args.slice(0, 2), ['setconf', 'transit']); assert.equal(kernel.guard, true);
    const intended = JSON.parse(await fs.readFile(opts.journalPath, 'utf8'));
    assert.ok(intended.pending); // Durable intention precedes every forward/rollback write.
    const text = await fs.readFile(args[2], 'utf8');
    if (process.platform !== 'win32') assert.equal((await fs.stat(args[2])).mode & 0o077, 0);
    kernel.writes++;
    const failure = kernel.failure; kernel.failure = null;
    if (failure === 'before') throw new Error(secret);
    kernel.config = failure === 'partial' ? text.replace('Jc = 4', 'Jc = 17') : text;
    if (failure) throw new Error(secret);
    return { stdout: '' };
  } };
  return { dir, owner, next: { ...owner, config: config.replace('Jc = 3', 'Jc = 4') }, kernel,
    tx: new CellAwgTransaction(opts), fresh: () => new CellAwgTransaction(opts) };
}
test('AWG explicit initialization requires exact ownership and keeps guard', async t => {
  const { tx, owner, kernel } = await fixture(t);
  await assert.rejects(tx.apply(owner), /initialized/);
  await tx.initialize(owner); assert.equal(kernel.guard, true); assert.equal(kernel.writes, 0);
  await assert.rejects(tx.initialize(owner), /already/);
});
test('AWG transaction applies, verifies, persists and never releases guard', async t => {
  const { tx, fresh, owner, next, kernel, dir } = await fixture(t);
  await tx.initialize(owner); await tx.apply(next);
  assert.equal(kernel.config, next.config); assert.equal(kernel.guard, true);
  assert.deepEqual((await fresh().load()).committed, next);
  await fresh().apply(next); assert.equal(kernel.writes, 1);
  assert.deepEqual(await fs.readdir(dir), ['awg.json']);
});
test('AWG initialization refuses a same-name foreign interface', async t => {
  const { tx, owner, kernel } = await fixture(t); kernel.links[0].ifalias = 'someone-else';
  await assert.rejects(tx.initialize(owner), /Foreign/); assert.equal(kernel.writes, 0);
  assert.equal((await tx.load()).committed, null);
});
test('AWG update never changes identity, interface, tag or MTU', async t => {
  const { tx, owner, kernel } = await fixture(t); await tx.initialize(owner);
  for (const next of [{ ...owner, interfaceName: 'other' }, { ...owner, mtu: 1400 },
    createAwgOwnership({ interfaceName: 'transit', config }),
    { ...owner, config: config.replace(secret, Buffer.alloc(32, 8).toString('base64')) }]) {
    await assert.rejects(tx.apply(next), /lifecycle/);
  }
  assert.equal(kernel.writes, 0);
});
test('AWG command failure before or after application restores old config without secrets', async t => {
  const { tx, owner, next, kernel, dir } = await fixture(t); await tx.initialize(owner);
  for (const failure of ['before', 'after']) {
    kernel.failure = failure;
    await assert.rejects(tx.apply(next), e => !e.message.includes(secret) && /restored under guard/.test(e.message));
    assert.equal(kernel.config, owner.config); assert.equal((await tx.load()).pending, null);
    assert.equal(kernel.guard, true); assert.deepEqual(await fs.readdir(dir), ['awg.json']);
  }
});
test('AWG unexpected partial config retains intent and refuses blind rollback', async t => {
  const { tx, fresh, owner, next, kernel } = await fixture(t); await tx.initialize(owner);
  kernel.failure = 'partial';
  await assert.rejects(tx.apply(next), /rollback refused/);
  assert.equal(kernel.guard, true); assert.ok((await tx.load()).pending);
  const writes = kernel.writes; await assert.rejects(fresh().recover(), /changed/);
  assert.equal(kernel.writes, writes); assert.match(kernel.config, /Jc = 17/);
});
test('AWG interrupted old/new state recovers confirmed config across new instances', async t => {
  const { tx, fresh, owner, next, kernel } = await fixture(t); await tx.initialize(owner);
  for (const actual of [owner.config, next.config]) {
    await tx.save({ version: 1, committed: owner, pending: { desired: next } }); kernel.config = actual;
    await assert.rejects(fresh().apply(next), /requires recovery/);
    await fresh().recover(); assert.equal(kernel.config, owner.config); assert.equal((await tx.load()).pending, null);
  }
});
test('AWG missing or drifting interface cannot be silently recreated or overwritten', async t => {
  const { tx, owner, next, kernel } = await fixture(t); await tx.initialize(owner);
  kernel.links = []; await assert.rejects(tx.apply(next), /missing/); await assert.rejects(tx.recover(), /missing/);
  assert.equal(kernel.writes, 0); assert.equal(kernel.guard, true);
});
test('AWG failed commit rolls back to previously confirmed configuration', async t => {
  const { tx, owner, next, kernel } = await fixture(t); await tx.initialize(owner);
  const save = tx.save.bind(tx);
  tx.save = value => !value.pending && value.committed.config === next.config
    ? Promise.reject(new Error('disk full')) : save(value);
  await assert.rejects(tx.apply(next), /restored under guard/);
  assert.equal(kernel.config, owner.config); assert.equal((await tx.load()).pending, null);
});
test('AWG malformed private journal errors do not include contents', async t => {
  const { tx, dir } = await fixture(t);
  await fs.writeFile(path.join(dir, 'awg.json'), `{"private":"${secret}" BROKEN`, { mode: 0o600 });
  await assert.rejects(tx.load(), e => /corrupt/.test(e.message) && !e.message.includes(secret));
});

test('AWG retirement clears only a journaled device proven absent after lifecycle removal', async t => {
  const { tx, owner, kernel } = await fixture(t);
  await tx.initialize(owner);
  await assert.rejects(tx.retire(), /still exists/);
  assert.deepEqual((await tx.load()).committed, owner);
  kernel.links = [];
  assert.deepEqual(await tx.retire(), { retired: true, guarded: true });
  assert.equal((await tx.load()).committed, null);
  assert.deepEqual(await tx.retire(), { retired: true, guarded: true });
});

test('AWG retirement refuses pending updates even if the interface disappeared', async t => {
  const { tx, owner, next, kernel } = await fixture(t);
  await tx.initialize(owner);
  await tx.save({ version: 1, committed: owner, pending: { desired: next } });
  kernel.links = [];
  await assert.rejects(tx.retire(), /requires recovery/);
  assert.ok((await tx.load()).pending);
  await tx.retire({ terminal: true });
  assert.equal((await tx.load()).committed, null);
});
