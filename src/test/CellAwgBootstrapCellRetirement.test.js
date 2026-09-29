'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CellAwgBootstrapCellRetirement } = require('../lib/CellAwgBootstrapCellRetirement');

function fixture() {
  const spec = { owner: { interfaceName: 'awg-enroll' } };
  let life = { phase: 'ready', spec }, awgState = { committed: spec.owner, pending: null };
  let nftState = { committed: { owned: true }, pending: null };
  let routeState = { committed: [{ file: 'ip', args: ['-4', 'route', 'add',
    '10.90.0.1/32', 'table', 'main', 'proto', '186', 'dev', 'awg-enroll'] }], pending: null };
  let guarded = false, permanent = true, connection = { status: 'registered' };
  let verifyPermanent = async () => permanent;
  let inventory = { routes4: [], routes6: [], rules4: [], rules6: [] };
  const events = [];
  const lifecycle = {
    load: async () => structuredClone(life),
    recover: async () => { assert.equal(guarded, true); events.push('life-recover');
      if (life.phase === 'removing') life = { phase: 'empty', spec: null }; },
    remove: async () => { assert.equal(guarded, true); events.push('life-remove');
      life = { phase: 'empty', spec: null }; },
  };
  const awg = {
    load: async () => structuredClone(awgState),
    retire: async () => {
      assert.equal(guarded, true);
      assert.equal(life.phase, 'empty');
      awgState = { committed: null, pending: null }; events.push('awg-retire');
    },
  };
  const firewall = { table: 'awg_easy_3_bootstrap',
    load: async () => structuredClone(nftState),
    recover: async () => { assert.equal(guarded, true); events.push('nft-recover'); },
    apply: async value => {
      assert.equal(guarded, true); nftState.committed = value; events.push('nft-apply');
    },
    current: async () => structuredClone(nftState.committed),
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  };
  const routes = {
    load: async () => structuredClone(routeState),
    recover: async () => { assert.equal(guarded, true); events.push('route-recover'); },
    apply: async value => {
      assert.equal(guarded, true); routeState.committed = value; events.push('route-apply');
    },
    inventory: async () => structuredClone(inventory),
  };
  const guard = { table: 'awg_easy_3_bootstrap_guard',
    load: async () => ({ interfaces: guarded ? ['awg-enroll'] : [], pending: null }),
    recover: async () => { events.push('guard-recover'); },
    protect: async () => { guarded = true; events.push('guard-protect'); },
    release: async check => {
      if (!await check()) throw new Error('Retirement readback failed');
      guarded = false; events.push('guard-release');
    },
  };
  const retirement = new CellAwgBootstrapCellRetirement({
    connection: { read: async () => connection }, lifecycle, awg, firewall, routes,
    guard, interfaceName: 'awg-enroll', verifyPermanent: state => verifyPermanent(state),
    now: () => 2000,
  });
  return { retirement, events, get guarded() { return guarded; },
    setPermanent: value => { permanent = value; },
    setVerification: value => { verifyPermanent = value; },
    setConnection: value => { connection = value; },
    setLife: value => { life = value; },
    setNftApply: value => { firewall.apply = value; },
    setInventory: value => { inventory = value; } };
}

test('verified permanent path permits fail-closed temporary retirement', async () => {
  const f = fixture();
  assert.deepEqual(await f.retirement.retire(), { retired: true });
  assert.deepEqual(f.events.filter(x => ['nft-apply', 'route-apply', 'life-remove',
    'awg-retire', 'guard-release'].includes(x)),
  ['nft-apply', 'route-apply', 'life-remove', 'awg-retire', 'guard-release']);
  assert.equal(f.guarded, false);
  assert.deepEqual(await f.retirement.retire(), { retired: true });
});

test('unverified permanent path retains temporary peer without mutation', async () => {
  const f = fixture(); f.setPermanent(false);
  await assert.rejects(f.retirement.retire(), /not verified/);
  assert.deepEqual(f.events, []);
});

test('expired unregistered invitation may be safely retired, active one may not', async () => {
  const f = fixture();
  f.setConnection({ status: 'pending', invitation: { expiresAt: 3000 } });
  await assert.rejects(f.retirement.retire(), /still needs registration/);
  f.setConnection({ status: 'pending', invitation: { expiresAt: 1000 } });
  await f.retirement.retire();
  assert.equal(f.guarded, false);
});

test('failure closing nft keeps the temporary path under guard', async () => {
  const f = fixture();
  f.setNftApply(async () => { throw new Error('nft failure'); });
  await assert.rejects(f.retirement.retire(), /nft failure/);
  assert.equal(f.guarded, true);
  assert.equal(f.events.includes('life-remove'), false);
});

test('interrupted lifecycle removal can finish before AWG journal retirement', async () => {
  const f = fixture(); f.setLife({ phase: 'removing', spec: { owner: { interfaceName: 'awg-enroll' } } });
  await f.retirement.retire();
  assert.equal(f.events.includes('life-remove'), false);
  assert.equal(f.events.includes('awg-retire'), true);
});

test('stray temporary routes or policy rules prevent guard release after retirement', async () => {
  for (const [section, entry] of [
    ['routes4', { dst: '10.90.0.1', dev: 'awg-enroll' }],
    ['rules6', { priority: 20001, iifname: 'awg-enroll' }],
  ]) {
    const f = fixture();
    f.setInventory({ routes4: [], routes6: [], rules4: [], rules6: [], [section]: [entry] });
    await assert.rejects(f.retirement.retire(), /Retirement readback failed/);
    assert.equal(f.guarded, true);
    assert.equal(f.events.includes('guard-release'), false);
  }
});

test('permanent path is checked again before the final guard release', async () => {
  const f = fixture();
  let checks = 0;
  f.setVerification(async () => ++checks < 3);
  await assert.rejects(f.retirement.retire(), /not verified/);
  assert.equal(checks, 3);
  assert.equal(f.guarded, true);
  assert.equal(f.events.includes('guard-release'), false);
});
