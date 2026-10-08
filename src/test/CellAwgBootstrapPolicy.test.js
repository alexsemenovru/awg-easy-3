'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bootstrapPolicySnapshot } = require('../lib/CellAwgBootstrapPolicy');
const { planNftReplacement } = require('../lib/CellNftOwnership');
const { CellNftTransaction } = require('../lib/CellNftTransaction');

test('bootstrap policy allows only registration TCP on the dedicated interface', () => {
  const snapshot = bootstrapPolicySnapshot({ interfaceName: 'awgenroll',
    controllerAddress: '10.90.0.1', registrationPort: 51822,
    peers: [{ phase: 'ready', cellAddress: '10.90.0.2' }] });
  const rules = snapshot.nftables.filter(item => item.rule).map(item => item.rule);
  assert.equal(rules.length, 7);
  assert.equal(rules[0].chain, 'input');
  assert.deepEqual(rules[0].expr.at(-2).match.left.payload, { protocol: 'tcp', field: 'dport' });
  assert.equal(rules[1].chain, 'input');
  assert.deepEqual(rules[1].expr.at(-1), { drop: null });
  assert.equal(rules[2].chain, 'output');
  assert.deepEqual(rules[2].expr.at(-2).match.left.payload, { protocol: 'tcp', field: 'sport' });
  assert.equal(rules[3].chain, 'output');
  assert.deepEqual(rules[3].expr[0].match.left.payload, { protocol: 'ip', field: 'daddr' });
  assert.equal(rules[3].expr[0].match.right, '10.90.0.2');
  assert.deepEqual(rules[3].expr.at(-1), { drop: null });
  assert.deepEqual(rules.slice(-3).map(rule => [rule.chain, rule.expr.at(-1)]), [
    ['output', { drop: null }],
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

test('multiple invitations keep nft readback chain order and block WAN fallback per peer', () => {
  const snapshot = bootstrapPolicySnapshot({ interfaceName: 'awgenroll',
    controllerAddress: '10.90.0.1', registrationPort: 51822,
    peers: [{ phase: 'ready', cellAddress: '10.90.0.3' },
      { phase: 'preparing', cellAddress: '10.90.0.2' }] });
  const rules = snapshot.nftables.filter(item => item.rule).map(item => item.rule);
  assert.deepEqual(rules.map(rule => rule.chain), [
    'input', 'input', 'input', 'output', 'output', 'output', 'output', 'output',
    'forward', 'forward',
  ]);
  assert.deepEqual(rules.slice(5, 7).map(rule => rule.expr[0].match.right),
    ['10.90.0.2', '10.90.0.3']);
  assert.ok(rules.slice(5, 7).every(rule => rule.expr.at(-1).drop === null));
});

test('separate bootstrap table transacts without adopting the main route table', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-bootstrap-nft-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const desired = bootstrapPolicySnapshot({ interfaceName: 'awgenroll',
    controllerAddress: '10.90.0.1', registrationPort: 51822, peers: [] });
  let current = null, guarded = false;
  const tx = new CellNftTransaction({ journalPath: path.join(directory, 'policy.json'),
    table: 'awg_easy_3_bootstrap', activateGuard: async () => { guarded = true; },
    runner: async (bin, args, options) => {
      assert.equal(bin, 'nft');
      if (args.includes('list')) return { stdout: JSON.stringify(args.at(-1) === 'tables'
        ? { nftables: current ? [current.nftables[0],
          { table: { family: 'inet', name: 'awg_easy_3_routes' } }] :
          [{ table: { family: 'inet', name: 'awg_easy_3_routes' } }] }
        : current) };
      assert.equal(guarded, true);
      if (args.includes('-c')) return { stdout: '' };
      const objects = JSON.parse(options.input).nftables.filter(item => item.add).map(item => item.add);
      current = objects.length ? { nftables: objects } : null;
      return { stdout: '' };
    } });
  await tx.apply(desired);
  assert.deepEqual((await tx.load()).committed, desired);
  await tx.apply(null);
  assert.equal(current, null);
});
