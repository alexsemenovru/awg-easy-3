'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { intervalElements, ruleExpressions, routingPolicySnapshot } = require('../lib/CellNftPolicyJson');
test('interval JSON merges overlaps and adjacency, preserves gaps and host endpoints', () => {
  assert.deepEqual(intervalElements(['198.51.100.128/25', '198.51.100.0/25', '198.51.100.0/26',
    '192.0.2.1-192.0.2.1', '203.0.113.1-203.0.113.9'], 4), [
    '192.0.2.1', { prefix: { addr: '198.51.100.0', len: 24 } }, { range: ['203.0.113.1', '203.0.113.9'] }]);
});
test('IPv6 intervals use exact 128-bit arithmetic and canonical addresses', () => {
  assert.deepEqual(intervalElements(['fd99:0:0:0:8000::/65', 'fd99::/65', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128'], 6), [
    { prefix: { addr: 'fd99::', len: 64 } }, 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']);
  assert.deepEqual(intervalElements(['0.0.0.0/1', '128.0.0.0/1'], 4), [{ prefix: { addr: '0.0.0.0', len: 0 } }]);
});
test('restricted rules normalize address sets and preserve filtering direction and verdict', () => {
  const rule = ruleExpressions('iifname "clients" ip6 daddr { fd88::3, fd88:0:0:0:0:0:0:2 } ct state established,related accept');
  assert.deepEqual(rule.expr[1].match.right, { set: ['fd88::2', 'fd88::3'] });
  assert.deepEqual(rule.expr[2].match.right, ['established', 'related']);
  assert.deepEqual(rule.expr.at(-1), { accept: null });
  const geo = ruleExpressions('ip daddr != @geo4_1234567890abcdef drop comment "GeoIP outbound"');
  assert.equal(geo.expr[0].match.op, '!='); assert.equal(geo.comment, 'GeoIP outbound');
});
test('unsupported expressions and invalid addresses cannot silently weaken a policy', () => {
  for (const line of ['iifname "x" jump foreign', 'ip saddr ::1 accept', 'tcp dport 70000 accept',
    'iifname "x" accept; flush ruleset', 'ip saddr 10.0.0.1', 'log prefix "anything" accept']) {
    assert.throws(() => ruleExpressions(line));
  }
  assert.throws(() => intervalElements(['10.0.0.9-10.0.0.1'], 4));
});
test('JSON table declares dependencies before rules and immutable GeoIP interval sets', () => {
  const json = routingPolicySnapshot({ input: ['iifname "clients" drop'], forward: [], output: [], nat: [],
    sets: [{ name: 'geo4_1234567890abcdef', family: 4, elements: [] }] });
  assert.equal(json.nftables.filter(x => x.chain).length, 4);
  const index = json.nftables.findIndex(x => x.set);
  assert.ok(index < json.nftables.findIndex(x => x.rule));
  assert.deepEqual(json.nftables[index].set.flags, ['interval']);
  assert.equal(json.nftables[index].set['auto-merge'], true);
  assert.ok(!Object.hasOwn(json.nftables[index].set, 'elem'));
});
