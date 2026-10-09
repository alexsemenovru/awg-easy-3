'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNftSnapshot, nftFingerprint, planNftReplacement, routingGuardSnapshot } = require('../lib/CellNftOwnership');
const table = 'awg_easy_3_routes';
const snapshot = () => ({ nftables: [{ table: { family: 'inet', name: table, handle: 2 } },
  { chain: { family: 'inet', table, name: 'forward', type: 'filter', hook: 'forward', prio: -15, policy: 'accept', handle: 3 } },
  { rule: { family: 'inet', table, chain: 'forward', handle: 4, expr: [{ drop: null }] } }] });
test('nft identity ignores kernel handles and metadata, but preserves policy changes', () => {
  const a = snapshot(), b = snapshot(); b.nftables[1].chain.handle = 123;
  b.nftables.unshift({ metainfo: { version: 'different' } });
  assert.equal(nftFingerprint(a, table), nftFingerprint(b, table));
  b.nftables.at(-1).rule.expr = [{ accept: null }];
  assert.notEqual(nftFingerprint(a, table), nftFingerprint(b, table));
});
test('same-name table cannot be adopted on first installation', () => {
  assert.throws(() => planNftReplacement({ table, current: snapshot(), owned: null, desired: snapshot() }), /Foreign/);
});
test('owned nft replacement is atomic declarative delete/add; identical policy is no-op', () => {
  const a = snapshot(), b = snapshot(); b.nftables.at(-1).rule.comment = 'new';
  const p = planNftReplacement({ table, current: a, owned: a, desired: b });
  assert.deepEqual(p.batch.nftables[0], { delete: { table: { family: 'inet', name: table } } });
  assert.equal(p.batch.nftables.filter(x => x.add).length, 3);
  assert.equal(planNftReplacement({ table, current: a, owned: a, desired: a }).changed, false);
});
test('changed rules and set elements are never silently overwritten', () => {
  const a = snapshot(), b = snapshot(); b.nftables.at(-1).rule.expr = [{ accept: null }];
  assert.throws(() => planNftReplacement({ table, current: b, owned: a, desired: a }), /changed/);
  a.nftables.push({ set: { family: 'inet', table, name: 'test', type: 'ipv4_addr', elem: ['10.0.0.1'] } });
  const c = structuredClone(a); c.nftables.at(-1).set.elem.push('10.0.0.2');
  assert.notEqual(nftFingerprint(a, table), nftFingerprint(c, table));
});
test('reject foreign families/tables, commands, extra tables and invalid roots', () => {
  for (const mutate of [x => x.nftables[0].table.name = 'filter', x => x.nftables[1].chain.family = 'ip',
    x => x.nftables.push({ flush: { ruleset: null } }), x => x.nftables.push(x.nftables[0]),
    x => x.command = 'anything']) {
    const s = snapshot(); mutate(s); assert.throws(() => normalizeNftSnapshot(s, table));
  }
});
test('missing owned table may be restored, deletion is scoped, inputs not mutated', () => {
  const a = snapshot(), copy = structuredClone(a);
  assert.ok(planNftReplacement({ table, current: null, owned: a, desired: a }).changed);
  assert.equal(planNftReplacement({ table, current: a, owned: a, desired: null }).batch.nftables.length, 1);
  assert.deepEqual(a, copy);
});
test('guard JSON is deterministic, blocks all managed directions and no unrelated interfaces', () => {
  const a = routingGuardSnapshot(['transit', 'clients']);
  assert.deepEqual(a, routingGuardSnapshot(['clients', 'transit']));
  assert.equal(a.nftables.filter(x => x.chain).length, 3);
  assert.equal(a.nftables.filter(x => x.rule).length, 8);
  assert.deepEqual(a.nftables.slice(0, 4).map(item => item.table ? 'table'
    : item.chain ? `chain:${item.chain.name}` : `rule:${item.rule.chain}`),
  ['table', 'chain:input', 'rule:input', 'rule:input']);
  assert.ok(a.nftables.filter(x => x.rule).every(x => Object.hasOwn(x.rule.expr.at(-1), 'drop')));
  assert.ok(!JSON.stringify(a).includes('eth0'));
  for (const input of [[], ['bad name'], ['same', 'same'], ['a\nflush ruleset']]) assert.throws(() => routingGuardSnapshot(input));
});
