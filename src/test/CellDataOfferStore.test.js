'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellDataOfferStore } = require('../lib/CellDataOfferStore');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const key = n => Buffer.alloc(32, n).toString('base64');
const keyManager = { derivePublicKey: async privateKey => privateKey === key(1) ? key(2) : key(9) };
const offer = () => ({ version: 1, controllerPrivateKey: key(1),
  cellPublicKey: key(4), presharedKey: key(3),
  descriptor: { version: 1, endpointHost: 'main.example.test', endpointPort: 53000,
    controllerAddress4: '10.250.0.1', cellAddress4: '10.250.0.2',
    controllerPublicKey: key(2), controllerClientSubnet4: '10.8.0.0/24',
    cellClientSubnet4: '10.88.0.0/24', profile: generateOfficialProfile() } });

test('Main stores one immutable data offer and returns no private or Cell peer key', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-data-offer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CellDataOfferStore(path.join(root, 'offers', 'cell.json'), keyManager);
  const value = offer();
  assert.equal(await store.create(value), true);
  assert.equal(await store.create(value), false);
  const publicOffer = await store.publicOffer(key(4));
  assert.equal(publicOffer.descriptor.controllerPublicKey, key(2));
  assert.ok(!JSON.stringify(publicOffer).includes(key(1)));
  assert.ok(!JSON.stringify(publicOffer).includes(key(4)));
  assert.equal(publicOffer.presharedKey, key(3));
  await assert.rejects(store.publicOffer(key(5)), /differs/);
  await assert.rejects(store.create({ ...value, cellPublicKey: key(5) }), /explicit transition/);
  assert.equal((await store.read()).cellPublicKey, key(4));
});

test('Main rejects an offer whose private key does not match its advertised public key', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-data-offer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CellDataOfferStore(path.join(root, 'cell.json'), keyManager);
  await assert.rejects(store.create({ ...offer(), controllerPrivateKey: key(6) }), /identity mismatch/);
  assert.equal(await store.read(), null);
});
