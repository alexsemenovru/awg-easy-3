'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CellTechnicalFailover, createCellTechnicalFailover } = require('../lib/CellTechnicalFailover');

function fixture(options = {}) {
  const calls = [];
  let now = 1000000;
  let bridgeActive = true;
  const discovery = { status: () => ({ technical: { bridgeActive } }),
    openBridge: async (...args) => { calls.push(['open', ...args]); return { address: '127.0.0.1', port: 49999 }; },
    closeBridge: async () => { calls.push(['close']); } };
  const value = { target: 'pinned-main-key', tuple: { source4: '192.0.2.1', sourcePort: 53185,
    peer4: '203.0.113.1', peerPort: 53084, interfaceName: 'control0' } };
  const redirect = { recover: async () => { calls.push(['recover']); },
    apply: async arg => { calls.push(['apply', arg]); } };
  const technical = new CellTechnicalFailover({ directory: '/private/technical',
    discovery: () => discovery, snapshot: async () => value,
    locked: work => work(), redirect, now: () => now, ...options });
  const report = async (state = 'degraded', consecutiveFailures = 3) => {
    technical.report({ state, consecutiveFailures }); await technical.pending;
  };
  return { calls, discovery, redirect, value, technical, report,
    advance: ms => { now += ms; }, lost: () => { bridgeActive = false; } };
}

test('reserve activates after repeated control failures with the verified original source tuple', async () => {
  const f = fixture();
  await f.technical.prepare();
  await f.report('degraded', 2);
  assert.deepEqual(f.calls, [['recover']]);
  await f.report();
  assert.equal(f.technical.status, 'technical');
  assert.deepEqual(f.calls.slice(1), [['open', 'pinned-main-key', '192.0.2.1'],
    ['apply', { ...f.value.tuple, bridgePort: 49999 }]]);
  await f.technical.close();
  assert.deepEqual(f.calls.slice(-2), [['recover'], ['close']]);
});

test('data/settings failures do not reroute a reachable control path or dismantle a working reserve', async () => {
  let reachable = true;
  const f = fixture({ reachable: async () => reachable });
  await f.report();
  assert.equal(f.calls.length, 0);
  reachable = false;
  f.advance(60000);
  await f.report();
  assert.equal(f.technical.active, true);
  reachable = true;
  const count = f.calls.length;
  await f.report();
  assert.equal(f.calls.length, count);
});

test('direct-path retry removes only the old control redirect before closing its bridge', async () => {
  const f = fixture();
  await f.report();
  f.advance(300000);
  await f.report('connected', 0);
  assert.equal(f.technical.active, false);
  assert.equal(f.technical.status, 'direct');
  assert.deepEqual(f.calls.slice(-2), [['recover'], ['close']]);
});

test('dead technical bridge recovers the direct path without touching user routes', async () => {
  const f = fixture();
  await f.report(); f.lost(); await f.report('connected', 0);
  assert.equal(f.technical.active, false);
  assert.deepEqual(f.calls.slice(-2), [['recover'], ['close']]);
});

test('changed ownership or failed NAT apply cannot leave an unjournaled reserve active', async () => {
  for (const changed of [true, false]) {
    const f = fixture();
    if (changed) {
      f.discovery.openBridge = async () => { f.value.tuple.peerPort++; return { address: '127.0.0.1', port: 49999 }; };
      // snapshot must return independent values, as the real persisted store does.
      const original = f.technical.snapshot;
      let count = 0;
      f.technical.snapshot = async () => {
        const value = structuredClone(await original());
        if (count++ > 0) value.target = 'different-main';
        return value;
      };
    } else f.redirect.apply = async () => { throw new Error('Interrupted kernel batch'); };
    await f.report();
    assert.equal(f.technical.active, false);
    assert.equal(f.technical.status, 'unavailable');
    assert.deepEqual(f.calls.slice(-2), [['recover'], ['close']]);
  }
});

test('a slow discovery is single-flight and shutdown never applies its late result', async () => {
  const f = fixture();
  let resolve;
  f.discovery.openBridge = () => new Promise(done => { resolve = done; });
  f.technical.report({ state: 'degraded', consecutiveFailures: 3 });
  while (!resolve) await new Promise(done => setImmediate(done));
  f.technical.report({ state: 'degraded', consecutiveFailures: 4 });
  const closing = f.technical.close();
  resolve({ address: '127.0.0.1', port: 49999 });
  await closing;
  assert.equal(f.calls.some(call => call[0] === 'apply'), false);
  assert.equal(f.technical.active, false);
});

test('product snapshot pins the registered control interface, endpoint and actual source socket', async () => {
  const key = byte => Buffer.alloc(32, byte).toString('base64');
  const plan = { spec: { owner: { ownerTag: 'awg-easy-3-cell:11111111-1111-4111-8111-111111111111',
    config: `[Interface]\nPrivateKey = ${key(1)}\n[Peer]\nPublicKey = ${key(2)}\nEndpoint = 203.0.113.1:53184\n` } } };
  let verified = true;
  let source = '192.0.2.1';
  const calls = [];
  const technical = createCellTechnicalFailover({
    config: { stateDirectory: require('node:path').resolve('cell-fixture'), resources: { interfaceNames: ['boot0', 'control0', 'user0'] } },
    bootstrapHost: { connectionStore: { read: async () => ({ status: 'registered', controllerKey: 'pinned' }) },
      permanentPlanStore: { read: async () => plan } }, discovery: () => null,
    buildPath: () => ({ interfaceName: 'control0', verifyOwned: async () => verified }),
    withLock: ({ work }) => work(), runner: async (file, args) => {
      calls.push([file, ...args]);
      if (file === 'awg') return { stdout: '53185' };
      return { stdout: JSON.stringify([{ dst: '203.0.113.1', prefsrc: source }]) };
    } });
  const current = await technical.snapshot();
  assert.equal(current.tuple.source4, '192.0.2.1');
  assert.equal(current.tuple.sourcePort, 53185);
  assert.equal(current.tuple.interfaceName, 'control0');
  assert.equal(await technical.redirect.verifyOwned({ ...current.tuple, bridgePort: 49999 }, { recovering: false }), true);
  source = '192.0.2.2';
  assert.equal(await technical.redirect.verifyOwned({ ...current.tuple, bridgePort: 49999 }, { recovering: false }), false);
  assert.equal(await technical.redirect.verifyOwned({ ...current.tuple, bridgePort: 49999 }, { recovering: true }), true);
  verified = false;
  await assert.rejects(technical.snapshot(), /ownership is unproven/);
  assert.equal(calls.some(call => call[1] === 'set' || call.includes('user0')), false);
});
