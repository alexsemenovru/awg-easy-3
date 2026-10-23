'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellReceivedDataOfferStore } = require('../lib/CellReceivedDataOfferStore');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const key = n => Buffer.alloc(32, n).toString('base64');
const server = { ipv4Subnet: '10.88.0.0/24' };
const offer = () => ({ version: 1, presharedKey: key(3), descriptor: {
  version: 1, endpointHost: 'main.example.test', endpointPort: 53000,
  controllerAddress4: '10.252.0.1', cellAddress4: '10.252.0.2',
  controllerPublicKey: key(2), controllerClientSubnet4: '10.8.0.0/24',
  cellClientSubnet4: '10.88.0.0/24', profile: generateOfficialProfile(),
} });

test('Cell pins its own signed data offer and rejects silent rotation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-received-data-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CellReceivedDataOfferStore(path.join(root, 'private', 'offer.json'), server);
  assert.equal(await store.read(), null);
  const offered = offer();
  assert.equal(await store.reserve(offered), true);
  assert.equal(await store.reserve(offered), false);
  assert.equal((await store.read()).descriptor.cellAddress4, '10.252.0.2');
  await assert.rejects(store.reserve({ ...offered, presharedKey: key(4) }), /explicit transition/);
  assert.equal((await store.read()).presharedKey, key(3));
});

test('Cell rejects an offer for another user subnet and unsafe local journal', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-received-data-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'private', 'offer.json');
  const store = new CellReceivedDataOfferStore(file, server);
  const wrong = offer(); wrong.descriptor.cellClientSubnet4 = '10.89.0.0/24';
  await assert.rejects(store.reserve(wrong), /does not match/);
  await store.reserve(offer());
  await fs.chmod(file, 0o644);
  if (process.platform !== 'win32') await assert.rejects(store.read(), /Unsafe/);
});

test('IPv6-capable Cell may accept an IPv4-only link when Main lacks IPv6', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-received-data-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CellReceivedDataOfferStore(path.join(root, 'offer.json'), {
    ...server, address6: 'fd88::1', ipv6Subnet: 'fd88::/64' });
  assert.equal(await store.reserve(offer()), true);
});
