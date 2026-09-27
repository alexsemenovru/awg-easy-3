'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CellAwgBootstrapStore } = require('../lib/CellAwgBootstrapStore');
const { createAwgBootstrapInvitation, decodeAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { identity, signRegistration } = require('../lib/CellRegistration');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const key = () => crypto.randomBytes(32).toString('base64');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-bootstrap-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new CellAwgBootstrapStore(path.join(directory, 'bootstrap.json'));
  const controller = identity();
  const temporaryKeys = { privateKey: key(), publicKey: key(), presharedKey: key() };
  const issued = await createAwgBootstrapInvitation({ controllerKey: controller.publicKey,
    endpointHost: 'example.test', endpointPort: 51820, registrationPort: 51822,
    controllerAddress: '10.90.0.1', cellAddress: '10.90.0.2', serverPublicKey: key(),
    profile: generateOfficialProfile(), keyManager: { generatePeerKeys: async () => temporaryKeys },
    now: 1000, lifetimeMs: 60000 });
  return { directory, store, controller, issued };
}

test('bootstrap registration is refused until the temporary peer is marked ready', async t => {
  const { store, controller, issued } = await fixture(t);
  await store.reserve(issued.record);
  const request = signRegistration(decodeAwgBootstrapInvitation(issued.code, 1001),
    identity().privateKey, 1002);
  await assert.rejects(store.completeSigned(request, controller.publicKey, 1003), /unavailable/);
  await store.markReady(issued.record.id);
  const result = await store.completeSigned(request, controller.publicKey, 1003);
  assert.equal(result.status, 'consumed');
  assert.deepEqual(await store.completeSigned(request, controller.publicKey, 1004), result);
  assert.equal((await store.read()).invitations[0].cellKey, result.cellKey);
  await assert.rejects(store.completeSigned(signRegistration(decodeAwgBootstrapInvitation(issued.code, 1001),
    identity().privateKey, 1002), controller.publicKey, 1003), /consumed/);
  await store.beginClose(issued.record.id);
  await assert.rejects(store.completeSigned(request, controller.publicKey, 1005), /unavailable/);
  await store.markClosed(issued.record.id);
  const closed = (await store.read()).invitations[0];
  assert.equal(closed.status, 'consumed');
  assert.equal(closed.temporaryPresharedKey, null);
});

test('crash-before-ready path closes a prepared peer without making code usable', async t => {
  const { store, issued } = await fixture(t);
  await store.reserve(issued.record);
  await store.abandonPreparing(issued.record.id, 1001);
  await store.markClosed(issued.record.id);
  const record = (await store.read()).invitations[0];
  assert.equal(record.status, 'revoked');
  assert.equal(record.phase, 'closed');
  await assert.rejects(store.markReady(record.id), /not preparing/);
});

test('bootstrap store rejects duplicate active address and peer and corrupt state', async t => {
  const { directory, store, issued } = await fixture(t);
  await store.reserve(issued.record);
  await assert.rejects(store.reserve({ ...issued.record, id: crypto.randomBytes(16).toString('hex') }),
    /Invalid AWG bootstrap state/);
  await fs.writeFile(path.join(directory, 'bootstrap.json'), '{broken');
  await assert.rejects(store.read(), /Invalid AWG bootstrap state/);
});
