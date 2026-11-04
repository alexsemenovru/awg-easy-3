'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CellDataActivationGroup } = require('../lib/CellDataActivationGroup');
const { routingPolicySnapshot } = require('../lib/CellNftPolicyJson');

const spec = { version: 1, interfaces: ['users', 'data0', 'data1'],
  commands: [], nftSnapshot: routingPolicySnapshot({
    input: [], forward: [], output: [], nat: [], sets: [] }) };
const path = (name, calls) => ({ interfaceName: name, retainGuard: true,
  lifecycle: { load: async () => ({ phase: 'ready' }) },
  initialize: async () => calls.push(`initialize:${name}`),
  recover: async () => calls.push(`recover:${name}`),
  verifyOwned: async () => true,
  releaseAfterRouting: async verify => {
    assert.equal(await verify(), true); calls.push(`release:${name}`);
  } });
const routing = calls => ({
  recover: async () => calls.push('routing:recover'),
  apply: async (value, options) => { assert.equal(options.retainGuard, true);
    calls.push('routing:apply'); },
  verify: async () => true,
  releaseCommitted: async () => calls.push('routing:release'),
});

test('Main releases shared route guard after all data links pass their probes', async () => {
  const calls = [];
  const group = new CellDataActivationGroup({ dataPaths: [path('data0', calls),
    path('data1', calls)], routing: routing(calls),
  verifyDataLink: async () => true });
  assert.deepEqual(await group.activate(spec), { ready: true, links: 2 });
  assert.deepEqual(calls, ['recover:data0', 'recover:data1', 'routing:recover',
    'routing:apply', 'release:data0', 'release:data1', 'routing:release']);
});

test('one failed data probe retains every path guard and the route guard', async () => {
  const calls = [];
  const group = new CellDataActivationGroup({ dataPaths: [path('data0', calls),
    path('data1', calls)], routing: routing(calls),
  verifyDataLink: async name => name === 'data0' });
  await assert.rejects(group.activate(spec), /not all verified/);
  assert.deepEqual(calls, ['recover:data0', 'recover:data1', 'routing:recover',
    'routing:apply']);
});

test('Docker compatibility failure cannot release any data or routing guard', async () => {
  const calls = [];
  const group = new CellDataActivationGroup({ dataPaths: [path('data0', calls),
    path('data1', calls)], routing: routing(calls), verifyDataLink: async () => true,
    beforeRelease: async names => { assert.deepEqual([...names].sort(), [...spec.interfaces].sort()); throw new Error('Docker policy changed'); } });
  await assert.rejects(group.activate(spec), /Docker policy changed/);
  assert.ok(!calls.some(x => x.startsWith('release:') || x === 'routing:release'));
});
