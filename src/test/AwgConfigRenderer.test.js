'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { generateOfficialProfile } = require('../lib/Awg3Config');
const { renderClientConfig, renderServerConfig } = require('../lib/AwgConfigRenderer');
const { buildDnsPolicy } = require('../lib/DnsPolicy');

const profile = () => generateOfficialProfile({
  randomInt: (() => {
    const values = [20, 30, 40, 5];
    return () => values.shift();
  })(),
  generateKey: () => Buffer.alloc(32, 9).toString('base64'),
});

test('renders an AWG 3.1 server without firewall shell hooks', () => {
  const config = renderServerConfig({
    privateKey: 'server-private-key',
    addresses: ['10.8.0.1/24', '2001:db8:42::1/64'],
    listenPort: 51820,
    profile: profile(),
    peers: [{
      name: 'Phone',
      publicKey: 'client-public-key',
      presharedKey: 'preshared-key',
      allowedIps: ['10.8.0.2/32', '2001:db8:42::2/128'],
    }],
  });

  assert.match(config, /^\[Interface\]/);
  assert.match(config, /^HeaderProtectionKey = /m);
  assert.match(config, /^RandomTrailers = on$/m);
  assert.doesNotMatch(config, /^AdvancedSecurity\s*=/m);
  assert.doesNotMatch(config, /PostUp|PostDown|iptables|nft/);
});

test('renders a dual-stack AmneziaVPN client with requested DNS defaults', () => {
  const config = renderClientConfig({
    privateKey: 'client-private-key',
    addresses: ['10.8.0.2/32', '2001:db8:42::2/128'],
    dnsPolicy: buildDnsPolicy({ serverHasIPv6: true }),
    profile: profile(),
    serverPublicKey: 'server-public-key',
    presharedKey: 'preshared-key',
    allowedIps: ['0.0.0.0/0', '::/0'],
    endpointHost: '2001:db8::10',
    endpointPort: 51820,
  });

  assert.match(config, /^DNS = 94\.140\.14\.14, 94\.140\.15\.15, 2a10:50c0::ad1:ff, 2a10:50c0::ad2:ff$/m);
  assert.match(config, /^Endpoint = \[2001:db8::10\]:51820$/m);
  assert.match(config, /^AllowedIPs = 0\.0\.0\.0\/0, ::\/0$/m);
  assert.match(config, /^PersistentKeepalive = 25-35$/m);
});

test('rejects newline injection in keys and endpoint hosts', () => {
  const base = {
    privateKey: 'client-private-key',
    addresses: ['10.8.0.2/32'],
    dnsPolicy: buildDnsPolicy(),
    profile: profile(),
    serverPublicKey: 'server-public-key',
    allowedIps: ['0.0.0.0/0'],
    endpointHost: 'vpn.example.com',
    endpointPort: 51820,
  };
  assert.throws(() => renderClientConfig({ ...base, privateKey: 'key\nPostUp = evil' }), /single-line/);
  assert.throws(() => renderClientConfig({ ...base, endpointHost: 'vpn.example.com\nPostUp=evil' }), /single-line/);
});
