'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');

const { generateHeaderProtectionKey } = require('../lib/Awg3Config');
const {
  buildAmneziaPayload,
  createVpnLink,
  decodeVpnLink,
  qtCompress,
  qtUncompress,
} = require('../lib/AmneziaVpnLink');

const options = () => ({
  description: 'My phone',
  hostName: 'vpn.example.com',
  port: 51820,
  dns: ['1.1.1.1', '8.8.8.8'],
  profile: {
    jc: 4,
    jmin: 35,
    jmax: 95,
    s1: 146,
    s2: 48,
    s3: 22,
    s4: 26,
    h1: '148736594-370455131',
    h2: '621025620-1240228083',
    h3: '1504827942-1530367889',
    h4: '1629521638-1833671031',
    headerProtectionKey: generateHeaderProtectionKey(),
    contentPaddingAddition: '50-100',
    randomTrailers: true,
    disableCookies: false,
  },
  client: {
    address: '10.8.0.2/32',
    privateKey: 'client-private-key',
    publicKey: 'client-public-key',
    serverPublicKey: 'server-public-key',
    presharedKey: 'preshared-key',
    allowedIps: ['0.0.0.0/0', '::/0'],
    persistentKeepalive: 25,
    mtu: 1280,
    nativeConfig: '[Interface]\nPrivateKey = client-private-key\n\n[Peer]\nPublicKey = server-public-key',
  },
});

test('implements the Qt qCompress framing used by AmneziaVPN', () => {
  const source = Buffer.from('AWG-Easy 3');
  const compressed = qtCompress(source);
  assert.equal(compressed.readUInt32BE(0), source.length);
  assert.deepEqual(zlib.inflateSync(compressed.subarray(4)), source);
  assert.deepEqual(qtUncompress(compressed), source);
});

test('builds the official third-party AWG container shape', () => {
  const input = options();
  const payload = buildAmneziaPayload(input);
  assert.equal(payload.defaultContainer, 'amnezia-awg');
  assert.equal(payload.containers[0].container, 'amnezia-awg');
  assert.equal(payload.containers[0].awg.isThirdPartyConfig, true);

  const lastConfig = JSON.parse(payload.containers[0].awg.last_config);
  assert.equal(lastConfig.HeaderProtectionKey, input.profile.headerProtectionKey);
});

test('round-trips every AWG 3.x field through a vpn:// link', () => {
  const input = options();
  const decoded = decodeVpnLink(createVpnLink(input));
  const lastConfig = JSON.parse(decoded.containers[0].awg.last_config);

  assert.equal(decoded.hostName, input.hostName);
  assert.equal(lastConfig.HeaderProtectionKey, input.profile.headerProtectionKey);
  assert.equal(lastConfig.ContentPaddingAddition, '50-100');
  assert.equal(lastConfig.RandomTrailers, 'on');
  assert.equal(lastConfig.DisableCookies, 'off');
  assert.equal(lastConfig.clientId, input.client.publicKey);
  assert.deepEqual(lastConfig.allowed_ips, ['0.0.0.0/0', '::/0']);
});

test('rejects malformed vpn links', () => {
  assert.throws(() => decodeVpnLink('https://example.com'), /vpn:\/\//);
  assert.throws(() => decodeVpnLink('vpn://not+base64'), /base64url/);
});
