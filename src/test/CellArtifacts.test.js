'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { buildCellArtifacts } = require('../lib/CellArtifacts');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { renderNftablesPolicy } = require('../lib/NftablesPolicy');
const key = n => Buffer.alloc(32, n).toString('base64');
const fixture = () => ({ server: { interfaceName: 'awg0', wanInterface: 'eth0', privateKey: key(1),
  address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24', address6: 'fd42::1', ipv6Subnet: 'fd42::/64',
  ipv6Mode: 'nat66', listenPort: 54321, profile: generateOfficialProfile() },
  settings: { schema: 1, clients: [{ id: 'guest', publicKey: key(2), address4: '10.8.0.2',
    address6: 'fd42::2', ipv4Enabled: true, ipv6Enabled: true, networkGroup: 'guest',
    geoPolicy: { mode: 'off', countries: [] } }] } });

test('cell compiler supports empty and guest-only cells without weakening panel defaults', () => {
  const input = fixture();
  const built = buildCellArtifacts(input);
  assert.match(built.nftables, /headless cell has no client-facing services/);
  assert.match(built.nftables, /main panel subnet must not fall back to WAN/);
  assert.ok(built.nftables.indexOf('main panel subnet must not fall back to WAN')
    < built.nftables.indexOf('AWG IPv4 to WAN'));
  assert.doesNotMatch(built.nftables, /home peers may access the panel/);
  assert.match(built.serverConfig, /AllowedIPs = 10\.8\.0\.2\/32, fd42::2\/128/);
  assert.throws(() => renderNftablesPolicy({ home4: [], guest4: [] }), /home peer/);
  input.settings.clients = [];
  assert.doesNotMatch(buildCellArtifacts(input).serverConfig, /\[Peer\]/);
});

test('cell addresses must be usable, unique and belong to local VPN subnets', () => {
  for (const patch of [{ address4: '10.9.0.2' }, { address4: '10.8.0.1' },
    { address4: '10.8.0.0' }, { address4: '10.8.0.255' }, { address6: 'fd43::2' },
    { address6: 'fd42:0:0:0:0:0:0:1' }]) {
    const input = fixture();
    Object.assign(input.settings.clients[0], patch);
    assert.throws(() => buildCellArtifacts(input), /conflicts/);
  }
});

test('disabled families and GeoIP remain enforced for cells', () => {
  const input = fixture();
  input.settings.clients[0].ipv4Enabled = false;
  input.settings.clients[0].geoPolicy = { mode: 'block', countries: ['RU'] };
  input.geoDatabase = { RU: { ipv4: ['192.0.2.0/24'], ipv6: ['2001:db8::/32'] } };
  const built = buildCellArtifacts(input);
  assert.match(built.nftables, /IPv4 permission: from VPN client/);
  assert.match(built.nftables, /ip6 saddr fd42::2 ip6 daddr @geo6_/);
  assert.doesNotMatch(built.nftables, /ip saddr 10\.8\.0\.2 ip daddr @geo4_/);
  input.settings.clients[0].ipv6Enabled = false;
  assert.doesNotMatch(buildCellArtifacts(input).serverConfig, /\[Peer\]/);
});

test('Linux nft validates generated headless rules in isolated network namespace',
  { skip: process.env.AWG_TEST_WSL !== '1' && process.env.AWG_NFT_KERNEL_TEST !== '1' }, () => {
    const built = buildCellArtifacts(fixture());
    const command = process.platform === 'win32' ? 'wsl.exe' : 'unshare';
    const args = process.platform === 'win32'
      ? ['-d', 'Ubuntu', '-u', 'root', '--', 'unshare', '-n', 'nft', '-c', '-f', '-']
      : ['-n', 'nft', '-c', '-f', '-'];
    const result = spawnSync(command, args, { input: built.nftables, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stderr}`);
  });
