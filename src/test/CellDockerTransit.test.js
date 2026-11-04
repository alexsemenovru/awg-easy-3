'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CellDockerTransit } = require('../lib/CellDockerTransit');
function fixture() {
  const rules = [], batches = [];
  const runner = async (file, args, options) => {
    if (file !== 'nft' || args[3] === 'ip6') throw Object.assign(new Error('No legacy chain'), { code: 1 });
    if (args.includes('DOCKER-USER')) return { stdout: JSON.stringify({ nftables: rules.map(rule => ({ rule })) }) };
    const batch = JSON.parse(options.input).nftables;
    batches.push(batch);
    for (const { insert: { rule } } of batch) {
      const actual = structuredClone(rule);
      for (const item of actual.expr) if (item.match?.left?.ct?.key === 'state') {
        item.match.op = '=='; item.match.right.set.reverse();
      }
      rules.push({ ...actual, handle: rules.length + 1 });
    }
    return { stdout: '' };
  };
  return { rules, batches, compat: new CellDockerTransit({ runner }) };
}
test('Docker transit is scoped, idempotent and expands by verified interface only', async () => {
  const f = fixture();
  await f.compat.ensure(['users','data0']);
  assert.equal(f.rules.length, 4);
  assert.ok(f.rules.every(r => r.family === 'ip' && r.chain === 'DOCKER-USER'));
  await f.compat.ensure(['users','data0']); assert.equal(f.batches.length, 1);
  await f.compat.ensure(['users','data0','data1']); assert.equal(f.rules.length, 6);
  assert.ok(f.rules.filter(r => r.comment.includes('oifname')).every(r => r.expr[1].match.left.ct.key === 'state'));
});
test('changed Docker transit rules and ambiguous duplicate markers are refused', async () => {
  const f = fixture(); await f.compat.ensure(['data0']);
  f.rules[0].expr[0].match.right = 'foreign';
  await assert.rejects(f.compat.ensure(['data0']), /Changed Docker transit/);
  await assert.rejects(f.compat.ensure(['bad interface']), /Verified AWG/);
  assert.equal(f.batches.length, 1);
});

test('legacy Docker transit checks exact existing rules before adding only missing ones', async () => {
  const inserted = [];
  const compat = new CellDockerTransit({ runner: async (file, args) => {
    if (file !== 'iptables-legacy') throw Object.assign(new Error('absent'), { code: 1 });
    if (args[0] === '-S') return { stdout: args[1] === 'FORWARD'
      ? '-A FORWARD -j DOCKER-USER' : '-N DOCKER-USER\n'+inserted.map(r => r.join(' ')).join('\n') };
    if (args[0] === '-C') {
      assert.ok(inserted.some(r => JSON.stringify(r.slice(3)) === JSON.stringify(args.slice(2))));
    } else { assert.equal(args[0], '-I'); inserted.push(args); }
    return { stdout: '' };
  } });
  await compat.ensure(['data0']); assert.equal(inserted.length, 2);
  await compat.ensure(['data0']); assert.equal(inserted.length, 2);
});
