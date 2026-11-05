'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CellDataActivation } = require('../lib/CellDataActivation');
const { routingPolicySnapshot } = require('../lib/CellNftPolicyJson');

function fixture({ phase = 'empty', probe = true, failRouting = false, foreignData = false,
  failFinalRelease = false } = {}) {
  const events = [];
  let dataGuard = false, routingGuard = false;
  const dataPath = {
    retainGuard: true, interfaceName: 'awgd0', lifecycle: { load: async () => ({ phase }) },
    initialize: async () => { events.push('data-init'); dataGuard = true; phase = 'ready'; },
    recover: async () => { events.push('data-recover'); dataGuard = true; },
    verifyOwned: async () => dataGuard && !foreignData,
    releaseAfterRouting: async verify => {
      events.push('data-check');
      if (!await verify()) throw new Error('data guard retained');
      assert.equal(routingGuard, true);
      dataGuard = false; events.push('data-release');
    },
  };
  const routing = {
    recover: async () => { assert.equal(dataGuard, true); events.push('routing-recover'); routingGuard = true; },
    apply: async (_spec, options) => {
      assert.deepEqual(options, { retainGuard: true });
      assert.equal(dataGuard, true); assert.equal(routingGuard, true);
      events.push('routing-apply');
    },
    verify: async () => !failRouting,
    releaseCommitted: async () => {
      assert.equal(dataGuard, false); assert.equal(routingGuard, true);
      if (failFinalRelease) throw new Error('routing guard release failed');
      routingGuard = false; events.push('routing-release');
    },
  };
  const activation = new CellDataActivation({ dataPath, routing,
    verifyDataLink: async () => { events.push('link-probe'); return probe; } });
  const spec = { version: 1, interfaces: ['awgclient', 'awgd0'], commands: [],
    nftSnapshot: routingPolicySnapshot({ input: [], forward: [], output: [], nat: [], sets: [] }) };
  return { activation, dataPath, spec, events,
    get dataGuard() { return dataGuard; }, get routingGuard() { return routingGuard; } };
}

test('first data activation releases guards only after route readback and link probe', async () => {
  const f = fixture();
  assert.deepEqual(await f.activation.activate(f.spec), { ready: true });
  assert.deepEqual(f.events, ['data-init', 'routing-recover', 'routing-apply',
    'data-check', 'link-probe', 'data-release', 'routing-release']);
  assert.equal(f.dataGuard, false); assert.equal(f.routingGuard, false);
});

test('restart recovers data path before user routing and probe failure stays guarded', async () => {
  const f = fixture({ phase: 'ready', probe: false });
  await assert.rejects(f.activation.activate(f.spec), /data guard retained/);
  assert.deepEqual(f.events, ['data-recover', 'routing-recover', 'routing-apply',
    'data-check', 'link-probe']);
  assert.equal(f.dataGuard, true); assert.equal(f.routingGuard, true);
});

test('routing readback failure never probes or releases the data interface', async () => {
  const f = fixture({ failRouting: true });
  await assert.rejects(f.activation.activate(f.spec), /data guard retained/);
  assert.equal(f.events.includes('link-probe'), false);
  assert.equal(f.dataGuard, true); assert.equal(f.routingGuard, true);
});

test('routing specification must include this dedicated data interface', async () => {
  const f = fixture();
  await assert.rejects(f.activation.activate({ ...f.spec, interfaces: ['awgclient'] }), /omits/);
  assert.deepEqual(f.events, []);
});

test('failed final release keeps the routing guard active', async () => {
  const f = fixture({ failFinalRelease: true });
  await assert.rejects(f.activation.activate(f.spec), /routing guard release failed/);
  assert.equal(f.dataGuard, false);
  assert.equal(f.routingGuard, true);
  assert.ok(f.events.includes('data-release'));
  assert.ok(!f.events.includes('routing-release'));
});

test('replay of a signed previously applied policy restores local service with Main offline', async () => {
  const f = fixture({ phase: 'ready', probe: false });
  assert.deepEqual(await f.activation.activate(f.spec, { replayApplied: true }), { ready: true });
  assert.equal(f.dataGuard, false);
  assert.equal(f.routingGuard, false);
  assert.deepEqual(f.events, ['data-recover', 'routing-recover', 'routing-apply',
    'data-check', 'link-probe', 'data-release', 'routing-release']);
});

test('offline replay never bypasses ownership or policy readback', async () => {
  for (const failure of [{ foreignData: true }, { failRouting: true }]) {
    const f = fixture({ phase: 'ready', probe: false, ...failure });
    await assert.rejects(f.activation.activate(f.spec, { replayApplied: true }), /guard retained/);
    assert.equal(f.dataGuard, true);
    assert.equal(f.routingGuard, true);
  }
});
