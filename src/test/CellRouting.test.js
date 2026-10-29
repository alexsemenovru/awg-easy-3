'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planCellTopology } = require('../lib/CellTopology');
const { compileCellRouting } = require('../lib/CellRoutingPolicy');
const key = n => Buffer.alloc(32, n).toString('base64');
function fixture() {
  return { version: 1, nodes: [{ id: 'main', role: 'controller', ipv4: true, ipv6: true },
    { id: 'cell', role: 'cell', ipv4: true, ipv6: true }], links: [{ a: 'main', b: 'cell', ipv4: true, ipv6: true }],
  clients: [{ entry: 'cell', exit: 'main', assignment: { id: 'phone', publicKey: key(1), presharedKey: key(2),
    address4: '10.88.0.2', address6: 'fd88::2', networkGroup: 'home', ipv4Enabled: true, ipv6Enabled: true,
    geoPolicy: { mode: 'off', countries: [] } } },
  { entry: 'main', exit: 'main', assignment: { id: 'desktop', publicKey: key(3),
    address4: '10.88.0.3', address6: 'fd88::3', networkGroup: 'home', ipv4Enabled: true, ipv6Enabled: true,
    geoPolicy: { mode: 'off', countries: [] } } }] };
}
const context = peer => ({ clientInterface: 'clients', wanInterface: 'wan', nat66: true,
  links: { [peer]: { interfaceName: 'transit', table: 52000, priority: 20000 } },
  panel: { address4: '10.88.0.1', address6: 'fd88::1', port: 51821 } });
test('only the entry receives client key material; routing policies follow the client', () => {
  const f = fixture();
  const main = planCellTopology(f).plans.find(p => p.node.id === 'main');
  assert.equal(main.peers.length, 1);
  assert.ok(!JSON.stringify(main).includes(key(2)));
  assert.equal(main.routes.find(r => r.id === 'phone').exit, 'main');
  assert.equal(f.clients[0].assignment.ipv6Enabled, true);
});
test('missing direct link or IPv6 capability closes the assigned path, never selects fallback', () => {
  const f = fixture(); f.links[0].ipv6 = false;
  const phone = planCellTopology(f).plans[1].routes[0];
  assert.equal(phone.enabled.ipv6, false); assert.equal(phone.enabled.ipv4, true);
  f.links = [];
  const closed = planCellTopology(f).plans[1].routes[0];
  assert.equal(closed.enabled.ipv4, false); assert.equal(closed.exit, 'main');
});
test('topology rejects ambiguity, unknown fields, aliases and unknown nodes', () => {
  for (const change of [f => f.nodes.push({ ...f.nodes[0] }), f => f.links.push({ ...f.links[0], a: 'cell', b: 'main' }),
    f => f.clients[0].exit = 'unknown', f => f.clients[0].assignment.command = 'anything',
    f => f.clients[1].assignment.address6 = 'fd88:0:0:0:0:0:0:2', f => f.nodes[1].role = 'controller']) {
    const f = fixture(); change(f); assert.throws(() => planCellTopology(f));
  }
});
test('remote-exit policy scopes rules to ingress, adds terminal unreachable routes, never host default', () => {
  const built = compileCellRouting({ topology: fixture(), nodeId: 'cell', context: context('main') });
  assert.ok(built.commands.some(c => c.args.includes('unreachable')));
  assert.ok(built.commands.filter(c => c.args.includes('rule')).every(c => c.args.includes('iif') && c.args.includes('from')));
  assert.ok(!built.commands.some(c => c.args.includes('default') && c.args.includes('main')));
  assert.ok(!built.nftables.includes('masquerade'));
  assert.match(built.nftables, /iifname "clients" oifname "transit" ip saddr 10\.88\.0\.2 accept/);
  assert.ok(!built.nftables.includes('iifname "clients" oifname "wan" ip saddr 10.88.0.2 accept'));
});
test('remote managed host destinations cannot fall back to the public route on link loss', () => {
  const cell = compileCellRouting({ topology: fixture(), nodeId: 'cell', context: context('main') });
  const main = compileCellRouting({ topology: fixture(), nodeId: 'main', context: context('cell') });
  assert.match(cell.nftables, /ip daddr 10\.88\.0\.1 drop/);
  assert.match(cell.nftables, /ip6 daddr fd88::1 drop/);
  assert.match(main.nftables, /ip daddr 10\.88\.0\.2 drop/);
  assert.match(main.nftables, /ip6 daddr fd88::2 drop/);
  assert.match(cell.nftables, /ip daddr 10\.88\.0\.3 drop/);
  assert.ok(!main.nftables.includes('ip daddr 10.88.0.3 drop'));
});
test('exit filters GeoIP before WAN allow and NATs only at exit', () => {
  const f = fixture(); f.clients[0].assignment.geoPolicy = { mode: 'block', countries: ['RU'] };
  const built = compileCellRouting({ topology: f, nodeId: 'main', context: context('cell'),
    geoDatabase: { RU: { ipv4: ['198.51.100.0/24'], ipv6: ['fd99::/64'] } } });
  assert.ok(built.nftables.indexOf('GeoIP outbound') < built.nftables.indexOf('ip saddr 10.88.0.2 accept'));
  assert.match(built.nftables, /oifname "wan" ip saddr 10\.88\.0\.2 masquerade/);
  assert.ok(!built.nftables.includes('oifname "transit" ip saddr 10.88.0.2 masquerade'));
});
test('Home exceptions precede isolation and Guest never obtains Home or panel access', () => {
  const f = fixture(); f.clients[0].assignment.networkGroup = 'guest';
  const built = compileCellRouting({ topology: f, nodeId: 'main', context: context('cell') });
  assert.ok(!built.nftables.includes('ip saddr 10.88.0.2 ip daddr 10.88.0.1 tcp dport'));
  assert.ok(!built.nftables.includes('ip saddr 10.88.0.2 ip daddr 10.88.0.3 accept'));
  assert.match(built.nftables, /oifname \{ "clients", "transit" \} drop/);
});
test('numbered Home groups share panel access only with their own peers', () => {
  const f = fixture();
  f.clients[0].assignment.networkGroup = 'home2';
  const mixed = compileCellRouting({ topology: f, nodeId: 'main', context: context('cell') });
  assert.match(mixed.nftables, /ip saddr 10\.88\.0\.2 ip daddr 10\.88\.0\.1 tcp dport 51821 accept/);
  assert.doesNotMatch(mixed.nftables, /ip saddr 10\.88\.0\.2 ip daddr 10\.88\.0\.3 accept/);
  f.clients[1].assignment.networkGroup = 'home2';
  const same = compileCellRouting({ topology: f, nodeId: 'main', context: context('cell') });
  assert.match(same.nftables, /ip saddr 10\.88\.0\.2 ip daddr 10\.88\.0\.3 accept/);
  assert.match(same.nftables, /ip6 saddr fd88::2 ip6 daddr fd88::3 accept/);
});
test('compiler rejects route allocation collisions and interface injection', () => {
  for (const change of [c => c.links.main.table = 254, c => c.links.main.interfaceName = 'wan',
    c => c.clientInterface = 'x"; accept', c => c.panel.address6 = 'fd88:0:0:0:0:0:0:2']) {
    const c = context('main'); change(c);
    assert.throws(() => compileCellRouting({ topology: fixture(), nodeId: 'cell', context: c }));
  }
});
test('IPv6 capability loss disables peers and WAN permissions, even with stored address', () => {
  const f = fixture(); f.nodes[0].ipv6 = false;
  const built = compileCellRouting({ topology: f, nodeId: 'cell', context: context('main') });
  assert.equal(built.plan.peers[0].ipv6Enabled, false);
  assert.ok(!built.nftables.includes('ip6 saddr fd88::2 accept'));
});

test('missing GeoIP data rejects compilation instead of silently removing the filter', () => {
  const f = fixture(); f.clients[0].assignment.geoPolicy = { mode: 'block', countries: ['RU'] };
  assert.throws(() => compileCellRouting({ topology: f, nodeId: 'cell', context: context('main') }), /unavailable/);
});

test('switching the desired exit does not add an implicit second exit', () => {
  const f = fixture(); f.clients[0].exit = 'cell';
  const built = compileCellRouting({ topology: f, nodeId: 'cell', context: context('main') });
  assert.match(built.nftables, /iifname "clients" oifname "wan" ip saddr 10\.88\.0\.2 accept/);
  assert.ok(!built.nftables.includes('iifname "clients" oifname "transit" ip saddr 10.88.0.2 accept'));
  assert.ok(!built.commands.some(c => c.args.includes('rule')));
});
