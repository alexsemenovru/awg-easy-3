'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapClientPolicySnapshot } = require('../lib/CellAwgBootstrapClientPolicy');

test('cell temporary interface admits only registration TCP to the controller', () => {
  const snapshot = bootstrapClientPolicySnapshot({ interfaceName: 'awg-enroll',
    cellAddress: '10.90.0.2', controllerAddress: '10.90.0.1', registrationPort: 51822 });
  const rules = snapshot.nftables.filter(item => item.rule).map(item => item.rule);
  assert.equal(rules.length, 7);
  assert.deepEqual(rules[0].expr.at(-2).match.left.payload, { protocol: 'tcp', field: 'sport' });
  assert.deepEqual(rules[1].expr.at(-1), { drop: null });
  assert.deepEqual(rules[2].expr.at(-2).match.left.payload, { protocol: 'tcp', field: 'dport' });
  assert.equal(rules[3].chain, 'output');
  assert.deepEqual(rules[3].expr[0].match.left.payload, { protocol: 'ip', field: 'daddr' });
  assert.equal(rules[3].expr[0].match.right, '10.90.0.1');
  assert.deepEqual(rules[3].expr.at(-1), { drop: null });
  assert.deepEqual(rules.slice(-3).map(rule => [rule.chain, rule.expr.at(-1)]), [
    ['output', { drop: null }],
    ['forward', { drop: null }], ['forward', { drop: null }],
  ]);
});

test('cell registration firewall validates IPv6 and refuses public or mixed families', () => {
  const base = { interfaceName: 'awg-enroll', cellAddress: 'fd35:e03:5563::2',
    controllerAddress: 'fd35:e03:5563::1', registrationPort: 51822 };
  assert.equal(bootstrapClientPolicySnapshot(base).nftables.filter(x => x.rule).length, 7);
  for (const patch of [{ cellAddress: '8.8.8.8' }, { controllerAddress: '10.90.0.1' },
    { cellAddress: base.controllerAddress }, { interfaceName: 'bad name' },
    { registrationPort: 0 }]) {
    assert.throws(() => bootstrapClientPolicySnapshot({ ...base, ...patch }));
  }
});
