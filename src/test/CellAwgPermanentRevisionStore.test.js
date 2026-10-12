'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
const { permanentControllerExpansionPlan } = require('../lib/CellAwgPermanentExpansionPlan');
const { permanentControllerRemovalPlan } = require('../lib/CellAwgPermanentRemovalPlan');
const { CellAwgPermanentRevisionStore } = require('../lib/CellAwgPermanentRevisionStore');

const key = () => crypto.randomBytes(32).toString('base64');
const changeTag = value => value.slice(0, -1) + (value.endsWith('0') ? '1' : '0');
async function plans() {
  const serverPublicKey = key(), privateKey = key();
  const descriptor = { version: 1, endpointHost: '198.51.100.42', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey, profile: generateOfficialProfile() };
  const keyManager = { derivePublicKey: async () => serverPublicKey };
  const first = { status: 'consumed', cellAddress: '10.90.0.2',
    awgPublicKey: key(), awgPresharedKey: key(), permanentDescriptor: descriptor };
  const second = { status: 'consumed', cellAddress: '10.90.0.3',
    awgPublicKey: key(), awgPresharedKey: key(), permanentDescriptor: {
      ...descriptor, cellAddress: '10.91.8.3' } };
  const base = { ...await permanentControllerPlan({ privateKey, descriptor,
    peers: [{ cellAddress: first.permanentDescriptor.cellAddress, awgPublicKey: first.awgPublicKey,
      awgPresharedKey: first.awgPresharedKey }], interfaceName: 'awgperm8', keyManager }), version: 1 };
  const next = await permanentControllerExpansionPlan({ currentPlan: base,
    records: [first, second], keyManager });
  return { base, next, first, second, keyManager };
}

test('revision intent survives restart and commits only after caller confirms kernel readback', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-revision-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { base, next } = await plans(), file = path.join(dir, 'revision.json');
  const store = new CellAwgPermanentRevisionStore(file, base);
  assert.deepEqual(await store.read(), store.empty());
  assert.deepEqual(await store.initialize(), store.empty());
  assert.deepEqual(await store.initialize(), store.empty());
  await store.prepare(next);
  const reopened = new CellAwgPermanentRevisionStore(file, base);
  const interrupted = await reopened.read();
  assert.equal(interrupted.revision, 0);
  assert.deepEqual(interrupted.pending, next);
  await assert.rejects(reopened.prepare(next), /recovery/);
  const committed = await reopened.commit();
  assert.equal(committed.revision, 1);
  assert.deepEqual(committed.committed, next);
  assert.equal(committed.pending, null);
  assert.deepEqual(await reopened.initialize(), committed);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o077, 0);
});

test('revision journal refuses changed old peer, wrong base and corrupt data', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-revision-bad-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { base, next } = await plans(), file = path.join(dir, 'revision.json');
  const store = new CellAwgPermanentRevisionStore(file, base);
  const changed = structuredClone(next);
  changed.spec.owner.ownerTag = changeTag(base.spec.owner.ownerTag);
  await assert.rejects(store.prepare(changed), /changes ownership/);
  await store.prepare(next);
  const wrongBase = new CellAwgPermanentRevisionStore(file, { ...base,
    spec: { ...base.spec, owner: { ...base.spec.owner, ownerTag:
      changeTag(base.spec.owner.ownerTag) } } });
  await assert.rejects(wrongBase.read(), /Corrupt/);
  await fs.writeFile(file, '{broken');
  await assert.rejects(store.read(), /Corrupt/);
});

test('successive revisions preserve base peers and reject a false revision count', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-revision-next-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { base, next, first, second, keyManager } = await plans();
  const file = path.join(dir, 'revision.json');
  const store = new CellAwgPermanentRevisionStore(file, base);
  await store.prepare(next); await store.commit();
  const third = { ...second, cellAddress: '10.90.0.4', awgPublicKey: key(),
    permanentDescriptor: { ...second.permanentDescriptor, cellAddress: '10.91.8.4' } };
  const later = await permanentControllerExpansionPlan({ currentPlan: next,
    records: [first, second, third], keyManager });
  await store.prepare(later);
  assert.equal((await store.commit()).revision, 2);
  const bad = await store.read();
  bad.committed = next;
  await fs.writeFile(file, JSON.stringify(bad), { mode: 0o600 });
  await assert.rejects(store.read(), /Corrupt/);
});

test('legacy additive journal upgrades on guarded removal and accepts later addition', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-revision-remove-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { base, next, second, keyManager } = await plans();
  const file = path.join(dir, 'revision.json');
  const store = new CellAwgPermanentRevisionStore(file, base);
  await store.prepare(next); await store.commit();
  assert.equal((await store.read()).version, 1);
  const reduced = await permanentControllerRemovalPlan({ currentPlan: next,
    record: second, keyManager });
  await store.prepare(reduced);
  const reopened = new CellAwgPermanentRevisionStore(file, base);
  assert.equal((await reopened.read()).version, 2);
  assert.deepEqual((await reopened.read()).pending, reduced);
  const committed = await reopened.commit();
  assert.equal(committed.revision, 2);
  assert.deepEqual(committed.committed, reduced);
  await store.prepare(next);
  assert.equal((await store.commit()).revision, 3);
  assert.equal((await store.read()).version, 2);
});

test('removal journal rejects changed remaining peer and controller identity', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-revision-remove-bad-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { base, next, second, keyManager } = await plans();
  const store = new CellAwgPermanentRevisionStore(path.join(dir, 'revision.json'), base);
  await store.prepare(next); await store.commit();
  const reduced = await permanentControllerRemovalPlan({ currentPlan: next,
    record: second, keyManager });
  const changed = structuredClone(reduced);
  changed.spec.owner.ownerTag = changeTag(reduced.spec.owner.ownerTag);
  await assert.rejects(store.prepare(changed), /changes ownership/);
  await store.prepare(reduced);
  const bad = await store.read();
  bad.pending = base;
  bad.pending.spec.owner.config = bad.committed.spec.owner.config;
  await fs.writeFile(store.filePath, JSON.stringify(bad));
  await assert.rejects(store.read(), /Corrupt/);
});
