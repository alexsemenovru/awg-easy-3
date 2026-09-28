'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { createAwgOwnership } = require('../lib/CellAwgOwnership');
const { renderBootstrapServerConfig } = require('../lib/CellAwgBootstrapConfig');
const { CellAwgBootstrapRuntime } = require('../lib/CellAwgBootstrapRuntime');

const key = () => crypto.randomBytes(32).toString('base64');
function fixture() {
  const interfaceName = 'awg-enroll', privateKey = key(), profile = generateOfficialProfile();
  const owner = createAwgOwnership({ interfaceName, config: renderBootstrapServerConfig({
    privateKey, listenPort: 51824, controllerAddress: '10.90.0.1', profile, peers: [],
  }) });
  let life = { version: 1, phase: 'ready', spec: { version: 1, owner,
    addresses: ['10.90.0.1/32'] }, blankHash: null };
  let awgState = { version: 1, committed: owner, pending: null };
  let nftState = { version: 1, committed: null, pending: null };
  let routeState = { version: 1, committed: [], pending: null };
  let nftCurrent = null, guarded = false;
  const events = [], invitations = [];
  const guard = { table: 'awg_easy_3_bootstrap_guard',
    load: async () => ({ interfaces: guarded ? [interfaceName] : [], pending: null }),
    recover: async () => { events.push('guard-recover'); },
    protect: async () => { guarded = true; events.push('guard-protect'); },
    release: async check => {
      events.push('guard-check');
      if (!await check()) throw new Error('Bad runtime');
      guarded = false; events.push('guard-release');
    },
  };
  const lifecycle = {
    load: async () => structuredClone(life),
    save: async value => { assert.equal(guarded, true); life = structuredClone(value); events.push('life-save'); },
    verify: async spec => {
      assert.equal(spec.owner.ownerTag, owner.ownerTag);
      assert.equal(spec.owner.config, awgState.committed.config);
      return { up: true };
    },
  };
  const awg = {
    load: async () => structuredClone(awgState),
    recover: async () => { assert.equal(guarded, true); events.push('awg-recover'); },
    inspect: async () => ({ manifest: awgState.committed, up: true }),
    apply: async desired => {
      assert.equal(guarded, true); awgState.committed = desired; events.push('awg-apply');
    },
  };
  const firewall = { table: 'awg_easy_3_bootstrap',
    load: async () => structuredClone(nftState),
    recover: async () => { assert.equal(guarded, true); events.push('nft-recover'); },
    apply: async desired => {
      assert.equal(guarded, true); nftState.committed = desired; nftCurrent = desired;
      events.push('nft-apply');
    },
    current: async () => structuredClone(nftCurrent),
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  };
  const routes = {
    load: async () => structuredClone(routeState),
    recover: async () => { assert.equal(guarded, true); events.push('route-recover'); },
    apply: async desired => {
      assert.equal(guarded, true); routeState.committed = structuredClone(desired);
      events.push('route-apply');
    },
    inventory: async () => {
      const result = { routes4: [], routes6: [], rules4: [], rules6: [] };
      for (const command of routeState.committed) {
        const family = command.args[0] === '-4' ? 4 : 6;
        result[`routes${family}`].push({ dst: command.args[3], table: 254,
          dev: interfaceName, protocol: 186, metric: family === 4 ? 0 : 1024,
          scope: family === 4 ? 'link' : 'global' });
      }
      return result;
    },
  };
  const runtime = new CellAwgBootstrapRuntime({ store: { read: async () => ({ invitations }) },
    lifecycle, awg, firewall, routes, guard, interfaceName, privateKey, listenPort: 51824,
    controllerAddress: '10.90.0.1', registrationPort: 51822, profile,
    verifyPermanent: async () => false });
  return { runtime, guard, events, invitations, get guarded() { return guarded; },
    get life() { return life; }, get awgState() { return awgState; } };
}

test('temporary peer is installed under guard before its registration firewall opening', async () => {
  const f = fixture();
  const record = { id: 'a'.repeat(32), phase: 'preparing', status: 'pending',
    cellAddress: '10.90.0.2', temporaryPublicKey: key(), temporaryPresharedKey: key() };
  f.invitations.push(record);
  await f.runtime.installPeer(record);
  assert.equal(f.guarded, false);
  assert.equal(f.life.spec.owner.config, f.awgState.committed.config);
  assert.deepEqual(f.events.filter(x => ['awg-apply', 'route-apply', 'nft-apply', 'guard-release'].includes(x)),
    ['awg-apply', 'route-apply', 'nft-apply', 'guard-release']);
  assert.equal(await f.runtime.verifyPeer(record), true);
});

test('temporary peer removal closes firewall before removing AWG peer', async () => {
  const f = fixture();
  const record = { id: 'b'.repeat(32), phase: 'preparing', status: 'pending',
    cellAddress: '10.90.0.2', temporaryPublicKey: key(), temporaryPresharedKey: key() };
  f.invitations.push(record);
  await f.runtime.installPeer(record);
  f.events.length = 0;
  record.phase = 'closing';
  await f.runtime.removePeer(record);
  assert.deepEqual(f.events.filter(x => ['awg-apply', 'route-apply', 'nft-apply', 'guard-release'].includes(x)),
    ['nft-apply', 'route-apply', 'awg-apply', 'guard-release']);
  assert.doesNotMatch(f.life.spec.owner.config, /\[Peer\]/);
});

test('unrelated guard state and unreserved peer fail without mutation', async () => {
  const f = fixture();
  const record = { id: 'c'.repeat(32), phase: 'preparing', status: 'pending',
    cellAddress: '10.90.0.2', temporaryPublicKey: key(), temporaryPresharedKey: key() };
  await assert.rejects(f.runtime.installPeer(record), /no preparing reservation/);
  f.invitations.push(record);
  f.guard.load = async () => ({ interfaces: ['foreign'], pending: null });
  await assert.rejects(f.runtime.installPeer(record), /Unrelated bootstrap guard/);
  assert.equal(f.events.length, 0);
});

test('failed firewall update keeps the guard and prevents code display', async () => {
  const f = fixture();
  const record = { id: 'd'.repeat(32), phase: 'preparing', status: 'pending',
    cellAddress: '10.90.0.2', temporaryPublicKey: key(), temporaryPresharedKey: key() };
  f.invitations.push(record);
  f.runtime.firewall.apply = async () => { throw new Error('nft failure'); };
  await assert.rejects(f.runtime.installPeer(record), /nft failure/);
  assert.equal(f.guarded, true);
  assert.equal(f.events.includes('guard-release'), false);
});

test('failed route update keeps the guard before opening registration TCP', async () => {
  const f = fixture();
  const record = { id: '9'.repeat(32), phase: 'preparing', status: 'pending',
    cellAddress: '10.90.0.2', temporaryPublicKey: key(), temporaryPresharedKey: key() };
  f.invitations.push(record);
  f.runtime.routes.apply = async () => { throw new Error('route failure'); };
  await assert.rejects(f.runtime.installPeer(record), /route failure/);
  assert.equal(f.guarded, true);
  assert.equal(f.events.includes('nft-apply'), false);
  assert.equal(f.events.includes('guard-release'), false);
});

test('restart repairs lifecycle journal after committed AWG change under guard', async () => {
  const f = fixture();
  const record = { id: 'e'.repeat(32), phase: 'preparing', status: 'pending',
    cellAddress: '10.90.0.2', temporaryPublicKey: key(), temporaryPresharedKey: key() };
  f.invitations.push(record);
  // Simulate a crash after the AWG child committed but before lifecycle save.
  f.awgState.committed = f.runtime.desired(f.invitations, f.life.spec).spec.owner;
  await f.runtime.installPeer(record);
  assert.equal(f.life.spec.owner.config, f.awgState.committed.config);
  assert.equal(f.events.includes('life-save'), true);
  assert.equal(f.events.includes('awg-apply'), false);
  assert.equal(f.guarded, false);
});

test('startup recovery refuses unfinished invitations until their journal is resolved', async () => {
  const f = fixture();
  f.invitations.push({ id: 'f'.repeat(32), phase: 'preparing', status: 'pending',
    cellAddress: '10.90.0.2', temporaryPublicKey: key(), temporaryPresharedKey: key() });
  await assert.rejects(f.runtime.recover(), /Recover invitation journal/);
  assert.equal(f.events.length, 0);
  f.invitations[0].phase = 'closed'; f.invitations[0].status = 'revoked';
  f.invitations[0].temporaryPresharedKey = null;
  await f.runtime.recover();
  assert.equal(f.guarded, false);
  assert.equal(f.events.indexOf('nft-apply') < f.events.indexOf('guard-release'), true);
});
