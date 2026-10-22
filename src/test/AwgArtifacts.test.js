'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAwgArtifacts } = require('../lib/AwgArtifacts');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { decodeVpnLink } = require('../lib/AmneziaVpnLink');

const fixture = () => ({
  server: {
    interfaceName: 'awg0',
    wanInterface: 'eth0',
    privateKey: 'server-private-key',
    publicKey: 'server-public-key',
    address4: '10.8.0.1',
    ipv4Subnet: '10.8.0.0/24',
    listenPort: 51820,
    endpointHost: 'vpn.example.com',
    panelPort: 51821,
    profile: generateOfficialProfile({
      randomInt: (() => {
        const values = [20, 30, 40, 5];
        return () => values.shift();
      })(),
      generateKey: () => Buffer.alloc(32, 11).toString('base64'),
    }),
  },
  clients: [
    {
      id: 'admin',
      name: 'Admin phone',
      enabled: true,
      networkGroup: 'home',
      address4: '10.8.0.2',
      privateKey: 'admin-private-key',
      publicKey: 'admin-public-key',
      presharedKey: 'admin-psk',
    },
    {
      id: 'guest',
      name: 'Guest phone',
      enabled: true,
      networkGroup: 'guest',
      address4: '10.8.0.3',
      privateKey: 'guest-private-key',
      publicKey: 'guest-public-key',
      presharedKey: 'guest-psk',
    },
  ],
});

test('builds server, firewall, native client and vpn-link artifacts together', () => {
  const artifacts = buildAwgArtifacts(fixture());
  assert.match(artifacts.serverConfig, /# Admin phone/);
  assert.match(artifacts.serverConfig, /# Guest phone/);
  assert.match(artifacts.nftables, /elements = \{ 10\.8\.0\.2 \}/);
  assert.match(artifacts.nftables, /elements = \{ 10\.8\.0\.3 \}/);
  assert.match(artifacts.clientArtifacts.admin.nativeConfig, /AllowedIPs = 0\.0\.0\.0\/0/);
  assert.match(artifacts.clientArtifacts.guest.nativeConfig, /AllowedIPs = 0\.0\.0\.0\/0/);

  const decoded = decodeVpnLink(artifacts.clientArtifacts.guest.vpnLink);
  const lastConfig = JSON.parse(decoded.containers[0].awg.last_config);
  assert.equal(lastConfig.clientId, 'guest-public-key');
  assert.equal(lastConfig.HeaderProtectionKey, fixture().server.profile.headerProtectionKey);
});

test('adds dual-stack addresses and NAT66 policy', () => {
  const input = fixture();
  input.server.ipv6Subnet = '2001:db8:42::/64';
  input.server.address6 = '2001:db8:42::1';
  input.server.ipv6Mode = 'nat66';
  input.clients[0].address6 = '2001:db8:42::2';
  input.clients[1].address6 = '2001:db8:42::3';

  const artifacts = buildAwgArtifacts(input);
  assert.equal(artifacts.serverHasIPv6, true);
  assert.match(artifacts.clientArtifacts.admin.nativeConfig, /Address = 10\.8\.0\.2\/32, 2001:db8:42::2\/128/);
  assert.doesNotMatch(artifacts.nftables, /block_ipv6/);
  assert.match(artifacts.nftables, /ip6 saddr 2001:db8:42::\/64 masquerade/);
  assert.match(artifacts.clientArtifacts.guest.nativeConfig, /AllowedIPs = 0\.0\.0\.0\/0, ::\/0/);
});

test('refuses a state with no enabled home client', () => {
  const input = fixture();
  input.clients[0].enabled = false;
  assert.throws(() => buildAwgArtifacts(input), /enabled home/);
});

test('Cell entry is absent from Main peers and firewall but exports its Cell endpoint', () => {
  const input = fixture();
  const cellId = 'a'.repeat(32);
  input.clients[1] = { ...input.clients[1], entryCellId: cellId, address4: '10.64.0.2' };
  const descriptor = { version: 1, endpointHost: 'cell.example.com', endpointPort: 51830,
    serverPublicKey: Buffer.alloc(32, 4).toString('base64'),
    address4: '10.64.0.1', ipv4Subnet: '10.64.0.0/24',
    profile: generateOfficialProfile() };
  const artifacts = buildAwgArtifacts({ ...input, entryDescriptors: { [cellId]: descriptor } });
  assert.match(artifacts.serverConfig, /# Admin phone/);
  assert.doesNotMatch(artifacts.serverConfig, /# Guest phone/);
  assert.doesNotMatch(artifacts.nftables, /10\.64\.0\.2/);
  assert.match(artifacts.clientArtifacts.guest.nativeConfig, /Endpoint = cell\.example\.com:51830/);
  assert.match(artifacts.clientArtifacts.guest.nativeConfig,
    new RegExp(`PublicKey = ${descriptor.serverPublicKey.replace(/[+]/g, '\\+')}`));
  assert.throws(() => buildAwgArtifacts(input), /Cell user descriptor/);
  assert.throws(() => buildAwgArtifacts({ ...input, entryDescriptors: {
    [cellId]: { ...descriptor, address4: '10.65.0.1', ipv4Subnet: '10.65.0.0/24' },
  } }), /does not belong/);
});
