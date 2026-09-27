'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapPolicySnapshot } = require('../lib/CellAwgBootstrapPolicy');
const { planNftReplacement } = require('../lib/CellNftOwnership');

test('bootstrap policy allows only registration TCP on the dedicated interface', () => {
  const snapshot = bootstrapPolicySnapshot({ interfaceName: 'awgenroll',
    controllerAddress: '10.90.0.1', registrationPort: 51822,
    peers: [{ phase: 'ready', cellAddress: '10.90.0.2' }] });
  const rules = snapshot.nftables.filter(item => item.rule).map(item => item.rule);
  assert.equal(rules.length, 6);
  assert.equal(rules[0].chain, 'input');
  assert.deepEqual(rules[0].expr.at(-2).match.left.payload, { protocol: 'tcp', field: 'dport' });
  assert.equal(rules[1].chain, 'output');
  assert.deepEqual(rules[1].expr.at(-2).match.left.payload, { protocol: 'tcp', field: 'sport' });
  assert.deepEqual(rules.slice(-4).map(rule => [rule.chain, rule.expr.at(-1)]), [
    ['input', { drop: null }], ['output', { drop: null }],
    ['forward', { drop: null }], ['forward', { drop: null }],
  ]);
  const closed = bootstrapPolicySnapshot({ interfaceName: 'awgenroll',
    controllerAddress: '10.90.0.1', registrationPort: 51822,
    peers: [{ phase: 'closing', cellAddress: '10.90.0.2' }] });
  assert.equal(closed.nftables.filter(item => item.rule).length, 4);
  assert.equal(planNftReplacement({ table: 'awg_easy_3_bootstrap', current: snapshot,
    owned: snapshot, desired: closed }).changed, true);
});

test('bootstrap policy supports IPv6 and rejects foreign or duplicate addresses', () => {
  const base = { interfaceName: 'awgenroll', controllerAddress: 'fd35:e03:5563::1',
    registrationPort: 51822, peers: [{ phase: 'preparing', cellAddress: 'fd35:e03:5563::2' }] };
  const snapshot = bootstrapPolicySnapshot(base);
  assert.equal(snapshot.nftables.filter(item => item.rule)[0].rule.expr[1].match.left.payload.protocol, 'ip6');
  for (const bad of [
    { peers: [...base.peers, base.peers[0]] },
    { peers: [{ phase: 'ready', cellAddress: '8.8.8.8' }] },
    { interfaceName: 'wan name' }, { registrationPort: 0 },
  ]) assert.throws(() => bootstrapPolicySnapshot({ ...base, ...bad }));
});
