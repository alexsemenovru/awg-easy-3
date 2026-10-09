'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { compileCellRouting } = require('../lib/CellRoutingPolicy');
const { normalizeNftSnapshot } = require('../lib/CellNftOwnership');

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
    assert.deepEqual(kernelReadback(nftSnapshot), nftSnapshot, `${nodeId} policy differs from kernel readback`);
  }
});
