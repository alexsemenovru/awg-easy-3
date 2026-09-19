'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { nftFingerprint, planNftReplacement, routingGuardSnapshot } = require('../src/lib/CellNftOwnership');
assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1');
const nft = (args, input) => execFileSync('nft', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const policy = 'table inet awg_easy_3_routes {\n set geo4_fixture { type ipv4_addr; flags interval; elements = { 198.51.100.0/24 }; }\n chain input { type filter hook input priority -15; policy accept; iifname "fixture" ip daddr @geo4_fixture drop; }\n}\n';
nft(['-c', '-f', '-'], policy);
assert.ok(!nft(['list', 'tables']).includes('awg_easy_3_routes'));
nft(['-f', '-'], policy);
const table = 'awg_easy_3_routes';
const read = () => JSON.parse(nft(['-j', 'list', 'table', 'inet', table]));
const original = read();
assert.throws(() => planNftReplacement({ table, current: original, owned: null, desired: original }), /Foreign/);
nft(['-f', '-'], 'table inet foreign_fixture {}\n');
function apply(owned, desired) {
  const plan = planNftReplacement({ table, current: read(), owned, desired });
  const input = JSON.stringify(plan.batch);
  nft(['-c', '-j', '-f', '-'], input); nft(['-j', '-f', '-'], input);
}
const changed = structuredClone(original);
changed.nftables.find(x => x.rule).rule.comment = 'updated';
apply(original, changed);
assert.equal(nftFingerprint(read(), table), nftFingerprint(changed, table));
assert.throws(() => planNftReplacement({ table, current: read(), owned: original, desired: original }), /changed/);
const current = read(); apply(current, original);
assert.equal(nftFingerprint(read(), table), nftFingerprint(original, table));
console.log('PASS real nft ownership, atomic JSON replacement and snapshot rollback');
const invalid = structuredClone(original);
invalid.nftables.find(x => x.rule).rule.chain = 'missing_chain';
const batch = planNftReplacement({ table, current: read(), owned: original, desired: invalid }).batch;
assert.throws(() => nft(['-j', '-f', '-'], JSON.stringify(batch)));
assert.equal(nftFingerprint(read(), table), nftFingerprint(original, table));
assert.ok(nft(['list', 'tables']).includes('foreign_fixture'));
console.log('PASS invalid atomic batch preserves original table and unrelated firewall');
const guardTable = 'awg_easy_3_routing_guard';
const guard = routingGuardSnapshot(['clients', 'transit']);
const guardBatch = planNftReplacement({ table: guardTable, current: null, owned: null, desired: guard }).batch;
nft(['-c', '-j', '-f', '-'], JSON.stringify(guardBatch));
nft(['-j', '-f', '-'], JSON.stringify(guardBatch));
const liveGuard = JSON.parse(nft(['-j', 'list', 'table', 'inet', guardTable]));
if (nftFingerprint(liveGuard, guardTable) !== nftFingerprint(guard, guardTable)) {
  console.error('Guard readback', JSON.stringify(liveGuard));
}
assert.equal(nftFingerprint(liveGuard, guardTable), nftFingerprint(guard, guardTable));
const removeGuard = planNftReplacement({ table: guardTable, current: liveGuard, owned: guard, desired: null });
nft(['-j', '-f', '-'], JSON.stringify(removeGuard.batch));
console.log('PASS precomputed guard JSON matches kernel readback and can be removed only as owned');
// Also run the durable guard journal cases on Linux, including file permissions.
execFileSync(process.execPath, ['--test', require.resolve('../src/test/CellRoutingGuard.test.js')], { stdio: 'inherit' });
