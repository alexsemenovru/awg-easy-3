'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { compileCellRouting } = require('../src/lib/CellRoutingPolicy');
const { normalizeNftSnapshot, planNftReplacement } = require('../src/lib/CellNftOwnership');
assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1');
const nft = (args, input) => execFileSync('nft', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
function same(actual, expected, label) {
  try { assert.deepEqual(actual, expected, label); }
  catch (error) { console.error(error.message.slice(0, 10000)); process.exit(1); }
}
const topology = { version: 1,
  nodes: [{ id: 'main', role: 'controller', ipv4: true, ipv6: true }, { id: 'cell', role: 'cell', ipv4: true, ipv6: true }],
  links: [{ a: 'main', b: 'cell', ipv4: true, ipv6: true }],
  clients: [3, 2].map(n => ({ entry: n === 2 ? 'cell' : 'main', exit: 'main', assignment: {
    id: `client${n}`, publicKey: Buffer.alloc(32, n).toString('base64'), address4: `10.88.0.${n}`, address6: `fd88::${n}`,
    networkGroup: 'home', ipv4Enabled: true, ipv6Enabled: true, geoPolicy: { mode: 'off', countries: [] } } })) };
const geoDatabase = { RU: {
  ipv4: ['198.51.100.0/25', '198.51.100.128/25', '203.0.113.1-203.0.113.9', '192.0.2.1/32'],
  ipv6: ['fd99::/65', 'fd99:0:0:0:8000::/65', 'fd98::1-fd98::9', 'fd97::1/128'] } };
let current = null;
const scenarios = [
  ['regular', () => {}],
  ['empty-geo', (t, db) => { db.RU = { ipv4: [], ipv6: [] }; }],
  ['single-client', t => { t.clients = [t.clients[0]]; }],
  ['no-clients', t => { t.clients = []; }],
  ['ipv4-only', t => { t.nodes[1].ipv6 = false; }],
  ['interfaces-reversed', (t, db, c) => { c.clientInterface = 'zclients'; Object.values(c.links)[0].interfaceName = 'atransit'; }],
  ['no-nat66', (t, db, c) => { c.nat66 = false; }],
];
for (const [scenario, modify] of scenarios) for (const mode of ['off', 'block', 'allow']) for (const nodeId of ['main', 'cell']) {
  const candidate = structuredClone(topology), database = structuredClone(geoDatabase);
  for (const client of candidate.clients) client.assignment.geoPolicy = { mode, countries: mode === 'off' ? [] : ['RU'] };
  const peer = nodeId === 'main' ? 'cell' : 'main';
  const context = {
    clientInterface: 'clients', wanInterface: 'wan', nat66: true,
    links: { [peer]: { interfaceName: 'transit', table: 52000, priority: 20000 } },
    panel: { address4: '10.88.0.1', address6: 'fd88::1', port: 51821 } };
  modify(candidate, database, context);
  const built = compileCellRouting({ topology: candidate, nodeId, geoDatabase: database, context });
  const read = () => JSON.parse(nft(['-j', 'list', 'table', 'inet', built.table]));
  nft(['-f', '-'], (current ? `delete table inet ${built.table}\n` : '') + built.nftables);
  same(normalizeNftSnapshot(read(), built.table), built.nftSnapshot, `${scenario}/${nodeId}/${mode} text readback`);
  const batch = planNftReplacement({ table: built.table, current: read(), owned: built.nftSnapshot, desired: null }).batch;
  nft(['-j', '-f', '-'], JSON.stringify(batch));
  const install = planNftReplacement({ table: built.table, current: null, owned: null, desired: built.nftSnapshot }).batch;
  nft(['-c', '-j', '-f', '-'], JSON.stringify(install)); nft(['-j', '-f', '-'], JSON.stringify(install));
  same(normalizeNftSnapshot(read(), built.table), built.nftSnapshot, `${scenario}/${nodeId}/${mode} JSON readback`);
  current = built.nftSnapshot;
  console.log(`PASS ${scenario}/${nodeId}/${mode}: precomputed JSON equals text policy and kernel readback`);
}
