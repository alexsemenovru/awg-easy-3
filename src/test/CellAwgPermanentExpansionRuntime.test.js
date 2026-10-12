'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
const { permanentControllerExpansionPlan } = require('../lib/CellAwgPermanentExpansionPlan');
const { permanentControllerRemovalPlan } = require('../lib/CellAwgPermanentRemovalPlan');
const { CellAwgPermanentExpansionRuntime } = require('../lib/CellAwgPermanentExpansionRuntime');
const { CellAwgPermanentRevisionStore } = require('../lib/CellAwgPermanentRevisionStore');

const key = () => crypto.randomBytes(32).toString('base64');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function plans() {
  const publicKey = key(), privateKey = key();
  const descriptor = { version: 1, endpointHost: '198.51.100.42', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey: publicKey, profile: generateOfficialProfile() };
  const first = { status: 'consumed', cellAddress: '10.90.0.2', awgPublicKey: key(),
    awgPresharedKey: key(), permanentDescriptor: descriptor };
  const second = { status: 'consumed', cellAddress: '10.90.0.3', awgPublicKey: key(),
    awgPresharedKey: key(), permanentDescriptor: { ...descriptor, cellAddress: '10.91.8.3' } };
  const keyManager = { derivePublicKey: async () => publicKey };
  const base = { ...await permanentControllerPlan({ privateKey, descriptor,
    peers: [{ cellAddress: first.permanentDescriptor.cellAddress, awgPublicKey: first.awgPublicKey,
      awgPresharedKey: first.awgPresharedKey }], interfaceName: 'awgperm8', keyManager }), version: 1 };
  const target = await permanentControllerExpansionPlan({ currentPlan: base,
    records: [first, second], keyManager });
  return { base, target, first, second, keyManager };
}

function fixture(base, target, providedRevisionStore = null) {
  let lifeSpec = structuredClone(base.spec), awgOwner = structuredClone(base.spec.owner);
  let routeList = structuredClone(base.routeCommands), policy = structuredClone(base.policy);
  let guarded = false, failNft = false, linkPresent = true;
  let pending = null, committed = null, revision = 0;
  const events = [];
  const components = {
    lifecycle: { load: async () => ({ phase: 'ready', spec: structuredClone(lifeSpec) }),
      link: async () => linkPresent ? { ifname: 'awgperm8' } : null,
      recover: async () => { linkPresent = true; events.push('life-recover'); },
      verify: async spec => ({ up: same(spec.owner, awgOwner) }),
      save: async value => { lifeSpec = structuredClone(value.spec); events.push('life-save'); } },
    awg: { load: async () => ({ committed: structuredClone(awgOwner), pending: null }),
      recover: async () => events.push('awg-recover'),
      apply: async owner => { assert.equal(guarded, true); awgOwner = structuredClone(owner);
        events.push('awg-apply'); } },
    routes: { load: async () => ({ committed: structuredClone(routeList), pending: null }),
      recover: async () => events.push('routes-recover'),
      apply: async list => { assert.equal(guarded, true); routeList = structuredClone(list);
        events.push('routes-apply'); } },
    firewall: { load: async () => ({ committed: structuredClone(policy), pending: null }),
      recover: async () => events.push('firewall-recover'), equal: same,
      apply: async next => { assert.equal(guarded, true); if (failNft) throw new Error('injected nft failure');
        policy = structuredClone(next); events.push('firewall-apply'); } },
    guard: { release: async check => { assert.equal(await check(), true);
      guarded = false; events.push('guard-release'); } },
  };
  const buildPath = ({ plan }) => ({ ...components,
    protect: async () => { guarded = true; events.push('guard-protect'); },
    recover: async () => { events.push('path-recover'); return { ready: true }; },
    verifyOwned: async () => same(lifeSpec, plan.spec) && same(awgOwner, plan.spec.owner)
      && same(routeList, plan.routeCommands) && same(policy, plan.policy),
    verifyOperational: async () => !guarded && same(lifeSpec, plan.spec)
      && same(awgOwner, plan.spec.owner) && same(routeList, plan.routeCommands)
      && same(policy, plan.policy),
  });
  const deployment = { store: { read: async () => base }, buildPath };
  const revisionStore = providedRevisionStore || { read: async () => ({ revision, committed, pending }),
    prepare: async next => { pending = next; },
    commit: async () => { committed = pending; pending = null; revision++; } };
  const runtime = new CellAwgPermanentExpansionRuntime({ deployment, revisionStore });
  return { runtime, deployment, events, setFailNft: value => { failNft = value; },
    get guarded() { return guarded; }, get revision() { return revision; },
    get pending() { return pending; }, get lifeSpec() { return lifeSpec; },
    get target() { return target; },
    simulateLifeLag: () => { lifeSpec = structuredClone(base.spec); },
    simulateReboot: () => { linkPresent = false; } };
}

test('second peer is applied under guard and revision commits after readback/release', async () => {
  const { base, target } = await plans(), f = fixture(base, target);
  assert.deepEqual(await f.runtime.prepare(target), { ready: true, revision: 1 });
  assert.equal(f.guarded, false); assert.equal(f.revision, 1);
  assert.equal(f.events.at(-1), 'guard-release');
  assert.ok(f.events.indexOf('guard-protect') < f.events.indexOf('awg-apply'));
  assert.ok(f.events.indexOf('awg-apply') < f.events.indexOf('routes-apply'));
  assert.deepEqual(await f.runtime.recoverCurrent(), target);
  assert.equal(f.events.at(-1), 'path-recover');
});

test('partial firewall failure retains guard and pending plan, retry resumes same identity', async () => {
  const { base, target } = await plans(), f = fixture(base, target);
  f.setFailNft(true);
  await assert.rejects(f.runtime.prepare(target), /injected nft failure/);
  assert.equal(f.guarded, true); assert.equal(f.revision, 0);
  assert.deepEqual(f.pending, target);
  f.simulateLifeLag();
  f.simulateReboot();
  f.setFailNft(false);
  assert.deepEqual(await f.runtime.recoverCurrent(), target);
  assert.equal(f.guarded, false); assert.equal(f.revision, 1);
  assert.deepEqual(f.lifeSpec.owner, target.spec.owner);
});

test('expansion refuses preparing a different plan while another intent is pending', async () => {
  const { base, target } = await plans(), f = fixture(base, target);
  f.setFailNft(true);
  await assert.rejects(f.runtime.prepare(target), /injected/);
  await assert.rejects(f.runtime.prepare({ ...target, routeCommands: [] }), /Another/);
  assert.equal(f.guarded, true);
});

test('third cell advances from the committed second-cell revision without reinstalling base', async () => {
  const { base, target, first, second, keyManager } = await plans();
  const f = fixture(base, target);
  await f.runtime.prepare(target);
  const third = { ...second, cellAddress: '10.90.0.4', awgPublicKey: key(),
    awgPresharedKey: key(), permanentDescriptor: {
      ...second.permanentDescriptor, cellAddress: '10.91.8.4' } };
  const later = await permanentControllerExpansionPlan({ currentPlan: target,
    records: [third, first, second], keyManager });
  assert.deepEqual(await f.runtime.prepare(later), { ready: true, revision: 2 });
  assert.equal(f.revision, 2);
  assert.equal(f.guarded, false);
  assert.deepEqual(await f.runtime.recoverCurrent(), later);
});

test('one-peer removal recovers under the same guard after interrupted policy update', async () => {
  const { base, target, second, keyManager } = await plans();
  const f = fixture(base, target);
  await f.runtime.prepare(target);
  const reduced = await permanentControllerRemovalPlan({ currentPlan: target,
    record: second, keyManager });
  f.setFailNft(true);
  await assert.rejects(f.runtime.prepare(reduced), /injected nft failure/);
  assert.equal(f.guarded, true);
  assert.equal(f.revision, 1);
  assert.deepEqual(f.pending, reduced);
  f.simulateReboot();
  f.setFailNft(false);
  assert.deepEqual(await f.runtime.recoverCurrent(), reduced);
  assert.equal(f.revision, 2);
  assert.equal(f.guarded, false);
  assert.deepEqual(f.lifeSpec.owner, reduced.spec.owner);
});

test('on-disk removal intent survives runtime restart after interrupted policy update', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-remove-restart-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { base, target, second, keyManager } = await plans();
  const file = path.join(dir, 'revision.json');
  const store = new CellAwgPermanentRevisionStore(file, base);
  const f = fixture(base, target, store);
  await f.runtime.prepare(target);
  const reduced = await permanentControllerRemovalPlan({ currentPlan: target,
    record: second, keyManager });
  f.setFailNft(true);
  await assert.rejects(f.runtime.prepare(reduced), /injected nft failure/);
  assert.deepEqual((await store.read()).pending, reduced);
  assert.equal(f.guarded, true);
  f.simulateReboot();
  f.setFailNft(false);
  const reopened = new CellAwgPermanentExpansionRuntime({ deployment: f.deployment,
    revisionStore: new CellAwgPermanentRevisionStore(file, base) });
  assert.deepEqual(await reopened.recoverCurrent(), reduced);
  assert.equal((await store.read()).version, 2);
  assert.equal((await store.read()).revision, 2);
  assert.equal((await store.read()).pending, null);
  assert.equal(f.guarded, false);
});
