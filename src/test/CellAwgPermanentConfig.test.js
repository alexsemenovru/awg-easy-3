'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { normalizeAwgConfig } = require('../lib/CellAwgSnapshot');
const { renderPermanentServerConfig, renderPermanentCellConfig } = require('../lib/CellAwgPermanentConfig');

const key = () => crypto.randomBytes(32).toString('base64');
function fixture() {
  const privateKey = key(), serverPublicKey = key();
  const descriptor = { version: 1, endpointHost: 'controller.example', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey, profile: generateOfficialProfile() };
  const cell = { status: 'registered', permanent: {
    privateKey: key(), presharedKey: key() }, controllerPath: descriptor };
  const peer = { cellAddress: descriptor.cellAddress, awgPublicKey: key(),
    awgPresharedKey: cell.permanent.presharedKey };
  const keyManager = { derivePublicKey: async () => serverPublicKey };
  return { privateKey, descriptor, cell, peer, keyManager };
}

test('signed descriptor and cell-owned keys render complementary permanent AWG configs', async () => {
  const f = fixture();
  const server = await renderPermanentServerConfig({ privateKey: f.privateKey,
    descriptor: f.descriptor, peers: [f.peer], keyManager: f.keyManager });
  const cell = renderPermanentCellConfig(f.cell, '203.0.113.25');
  const serverParsed = normalizeAwgConfig(server.config);
  const cellParsed = normalizeAwgConfig(cell.config);
  assert.equal(server.address, '10.91.8.1/32');
  assert.equal(cell.address, '10.91.8.2/32');
  assert.equal(cell.controlPort, 53083);
  assert.equal(serverParsed.peers[0].publickey, f.peer.awgPublicKey);
  assert.equal(cellParsed.peers[0].publickey, f.descriptor.serverPublicKey);
  assert.equal(cellParsed.peers[0].presharedkey, serverParsed.peers[0].presharedkey);
  assert.match(cell.config, /Endpoint = 203\.0\.113\.25:53084/);
  assert.ok(!cell.config.includes(f.privateKey));
});

test('permanent config refuses a mismatched server identity and duplicate peers', async () => {
  const f = fixture();
  await assert.rejects(renderPermanentServerConfig({ privateKey: f.privateKey,
    descriptor: f.descriptor, peers: [f.peer],
    keyManager: { derivePublicKey: async () => key() } }), /identity/);
  await assert.rejects(renderPermanentServerConfig({ privateKey: f.privateKey,
    descriptor: f.descriptor, peers: [f.peer, { ...f.peer, awgPublicKey: key() }],
    keyManager: f.keyManager }), /duplicate/);
  assert.throws(() => renderPermanentCellConfig({ ...f.cell,
    controllerPath: { ...f.descriptor, controllerAddress: '8.8.8.8' } }, '203.0.113.25'));
  assert.throws(() => renderPermanentCellConfig(f.cell), /Literal/);
});

test('permanent cell config brackets a public IPv6 endpoint', () => {
  const f = fixture();
  const cell = renderPermanentCellConfig({ ...f.cell,
    controllerPath: { ...f.descriptor, endpointHost: '2001:db8::1' } });
  assert.match(cell.config, /Endpoint = \[2001:db8::1\]:53084/);
});
