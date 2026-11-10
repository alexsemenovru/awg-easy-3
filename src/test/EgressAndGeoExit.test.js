'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileCellRouting } = require('../lib/CellRoutingPolicy');
const { manifest } = require('../lib/CellRouteOwnership');
const { renderNftablesPolicy } = require('../lib/NftablesPolicy');
const { prepareRestoredPanelState } = require('../lib/BackupSnapshot');
const { fixture } = require('./helpers/BackupFixture');
const context = { clientInterface: 'clients', wanInterface: 'wan', nat66: true,
  egressIpv4: '198.51.100.22', panel: { address4: '10.8.0.1', port: 51821 },
  links: { cell: { interfaceName: 'transit', table: 52000, priority: 20000 } } };
const topology = () => ({ version: 1,
  nodes: [{ id: 'main', role: 'controller', ipv4: true, ipv6: true },
    { id: 'cell', role: 'cell', ipv4: true, ipv6: true }],
  links: [{ a: 'main', b: 'cell', ipv4: true, ipv6: true }],
  clients: [{ entry: 'main', exit: 'main', geoRoute: { mode: 'include', countries: ['RU'], exitNodeId: 'cell' },
    assignment: { id: 'phone', address4: '10.8.0.2', publicKey: Buffer.alloc(32, 1).toString('base64'),
      networkGroup: 'home', ipv4Enabled: true, ipv6Enabled: false, geoPolicy: { mode: 'off', countries: [] } } }] });
const database = { RU: { ipv4: ['203.0.113.0/24'], ipv6: [] } };

test('explicit SNAT is restricted to forwarded VPN ingress; default remains masquerade', () => {
  const base = { interfaceName: 'clients', wanInterface: 'wan', ipv4Subnet: '10.8.0.0/24', home4: ['10.8.0.2'], guest4: [] };
  assert.match(renderNftablesPolicy({ ...base, egressIpv4: '198.51.100.22' }), /iifname "clients" oifname "wan" ip saddr 10\.8\.0\.0\/24 snat ip to 198\.51\.100\.22/);
  assert.match(renderNftablesPolicy(base), /masquerade comment "AWG-Easy 3 IPv4 NAT"/);
  for (const address of ['127.0.0.1', '::1', '224.0.0.1', '1.2.3.4; accept']) assert.throws(() => renderNftablesPolicy({ ...base, egressIpv4: address }));
});
test('restore keeps destination egress or clears the old machine binding', async () => {
  const snapshot = await fixture();
  const source = snapshot.files.find(file => file.area === 'panel');
  const state = JSON.parse(Buffer.from(source.data, 'base64'));
  state.server.egressIpv4 = '198.51.100.22';
  const bytes = Buffer.from(JSON.stringify(state)); source.data = bytes.toString('base64');
  source.sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const target = { interfaceName: 'newvpn', wanInterface: 'newwan', endpointHost: 'new.example.test', listenPort: 55000, panelPort: 51821 };
  assert.equal(prepareRestoredPanelState(snapshot, target).server.egressIpv4, undefined);
  assert.equal(prepareRestoredPanelState(snapshot, { ...target, egressIpv4: '198.51.100.33' }).server.egressIpv4, '198.51.100.33');
});
test('country exit uses a bounded mark selector and keeps local SNAT on the other branch', () => {
  const built = compileCellRouting({ topology: topology(), nodeId: 'main', context, geoDatabase: database });
  assert.equal(manifest(built.commands).filter(item => item.record.kind === 'rule' && item.record.mark === 67108864).length, 1);
  assert.match(built.nftables, /ip daddr @geo4_.* meta mark set meta mark \| 0x04000000/);
  assert.match(built.nftables, /ip daddr != @geo4_.* snat ip to 198\.51\.100\.22/);
  assert.match(built.nftables, /unavailable|iifname .* drop/);
  assert.throws(() => compileCellRouting({ topology: topology(), nodeId: 'main', context, geoDatabase: {} }), /unavailable/);
});
test('country exit can be local while the general exit is remote, including inverse country matching', () => {
  const desired = topology(); desired.clients[0].exit = 'cell';
  desired.clients[0].geoRoute = { mode: 'exclude', countries: ['RU'], exitNodeId: 'main' };
  const built = compileCellRouting({ topology: desired, nodeId: 'main', context, geoDatabase: database });
  assert.equal(manifest(built.commands).filter(item => item.record.kind === 'rule' && item.record.mark === 0).length, 1);
  assert.match(built.nftables, /ip daddr != @geo4_.* meta mark set meta mark \|/);
});
