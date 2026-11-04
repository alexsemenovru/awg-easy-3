'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { compileCellRouting } = require('../lib/CellRoutingPolicy');
const { normalizeNftSnapshot, nftFingerprint } = require('../lib/CellNftOwnership');

// Explicit opt-in: this invokes nft as root, but only inside a disposable
// network namespace. It never changes the host's persistent firewall.
const enabled = process.env.AWG_NFT_KERNEL_TEST === '1';
const key = number => Buffer.alloc(32, number).toString('base64');
const topology = {
  version: 1,
  nodes: [{ id: 'main', role: 'controller', ipv4: true, ipv6: true },
    { id: 'cell', role: 'cell', ipv4: true, ipv6: true }],
  links: [{ a: 'main', b: 'cell', ipv4: true, ipv6: true }],
  clients: [
    { entry: 'cell', exit: 'main', assignment: { id: 'phone', publicKey: key(1),
      address4: '10.88.0.2', address6: 'fd88::2', networkGroup: 'home',
      ipv4Enabled: true, ipv6Enabled: true, geoPolicy: { mode: 'block', countries: ['RU'] } } },
    { entry: 'main', exit: 'main', assignment: { id: 'desktop', publicKey: key(2),
      address4: '10.88.0.3', address6: 'fd88::3', networkGroup: 'home',
      ipv4Enabled: true, ipv6Enabled: true, geoPolicy: { mode: 'off', countries: [] } } },
  ],
};
const context = peer => ({ clientInterface: 'clients', wanInterface: 'wan', nat66: true,
  links: { [peer]: { interfaceName: 'transit', table: 52000, priority: 20000 } },
  panel: { address4: '10.88.0.1', address6: 'fd88::1', port: 51821 } });
const geoDatabase = { RU: { ipv4: ['198.51.100.0/24', '198.51.101.0/24'], ipv6: ['fd99::/64'] } };

function kernelReadback(snapshot) {
  const command = 'nft -j -f - && nft -j list table inet awg_easy_3_routes';
  const args = process.platform === 'win32'
    ? ['-d', 'Ubuntu', '-u', 'root', '--', 'unshare', '-n', 'sh', '-c', command]
    : ['-n', 'sh', '-c', command];
  const binary = process.platform === 'win32' ? 'wsl.exe' : 'unshare';
  const input = JSON.stringify({ nftables: snapshot.nftables.map(item => ({ add: item })) });
  const result = spawnSync(binary, args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return normalizeNftSnapshot(JSON.parse(result.stdout), 'awg_easy_3_routes');
}

test('complex controller and cell policies match isolated nft kernel readback', { skip: !enabled }, () => {
  for (const [nodeId, peer] of [['main', 'cell'], ['cell', 'main']]) {
    const { nftSnapshot } = compileCellRouting({ topology, nodeId, context: context(peer), geoDatabase });
    assert.equal(nftFingerprint(kernelReadback(nftSnapshot), 'awg_easy_3_routes'),
      nftFingerprint(nftSnapshot, 'awg_easy_3_routes'), `${nodeId} policy differs from kernel readback`);
  }
});

test('numbered Home isolation matches isolated nft kernel readback', { skip: !enabled }, () => {
  const grouped = structuredClone(topology);
  grouped.clients[0].assignment.networkGroup = 'home2';
  for (const [nodeId, peer] of [['main', 'cell'], ['cell', 'main']]) {
    const { nftSnapshot } = compileCellRouting({ topology: grouped, nodeId,
      context: context(peer), geoDatabase });
    assert.equal(nftFingerprint(kernelReadback(nftSnapshot), 'awg_easy_3_routes'),
      nftFingerprint(nftSnapshot, 'awg_easy_3_routes'),
      `${nodeId} numbered Home policy differs from kernel readback`);
  }
});

test('two Cells with distinct client exits match isolated nft kernel readback', { skip: !enabled }, () => {
  const nodes = [{ id: 'main', role: 'controller', ipv4: true, ipv6: true },
    { id: 'cellA', role: 'cell', ipv4: true, ipv6: true },
    { id: 'cellB', role: 'cell', ipv4: true, ipv6: false }];
  const topology = { version: 1, nodes,
    links: [{ a: 'main', b: 'cellA', ipv4: true, ipv6: true },
      { a: 'main', b: 'cellB', ipv4: true, ipv6: false }],
    clients: [
      { entry: 'main', exit: 'cellA', assignment: { id: 'owner', publicKey: key(11),
        address4: '10.8.0.2', address6: 'fd08::2', networkGroup: 'home',
        ipv4Enabled: true, ipv6Enabled: true,
        geoPolicy: { mode: 'block', countries: ['RU'] } } },
      { entry: 'cellA', exit: 'main', assignment: { id: 'phone', publicKey: key(12),
        address4: '10.64.0.2', address6: 'fd64::2', networkGroup: 'home',
        ipv4Enabled: true, ipv6Enabled: true,
        geoPolicy: { mode: 'off', countries: [] } } },
      { entry: 'cellB', exit: 'cellB', assignment: { id: 'guest', publicKey: key(13),
        address4: '10.65.0.2', networkGroup: 'guest',
        ipv4Enabled: true, ipv6Enabled: false,
        geoPolicy: { mode: 'off', countries: [] } } },
    ] };
  const links = { main: { cellA: ['transitA', 52000, 20000],
    cellB: ['transitB', 52001, 20001] },
  cellA: { main: ['transitA', 52000, 20000] },
  cellB: { main: ['transitB', 52001, 20001] } };
  for (const node of nodes) {
    const context = { clientInterface: 'clients', wanInterface: 'wan',
      nat66: node.ipv6,
      links: Object.fromEntries(Object.entries(links[node.id]).map(([peer, values]) =>
        [peer, { interfaceName: values[0], table: values[1], priority: values[2] }])),
      panel: { address4: '10.8.0.1', address6: 'fd08::1', port: 51821 } };
    const { nftSnapshot } = compileCellRouting({ topology, nodeId: node.id,
      context, geoDatabase });
    assert.equal(nftFingerprint(kernelReadback(nftSnapshot), 'awg_easy_3_routes'),
      nftFingerprint(nftSnapshot, 'awg_easy_3_routes'),
      `${node.id} policy differs from kernel readback`);
  }
});
