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
const { signAwgRegistration } = require('../lib/CellAwgRegistration');
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

test('bootstrap store never overlaps active temporary addresses or reserved permanent addresses', async t => {
  const { store, issued } = await fixture(t);
  const descriptor = { version: 1, endpointHost: 'example.test', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey: key(), profile: generateOfficialProfile() };
  await store.reserve({ ...issued.record, permanentDescriptor: descriptor });
  const second = { ...issued.record, id: crypto.randomBytes(16).toString('hex'),
    temporaryPublicKey: key(), cellAddress: '10.90.0.3',
    permanentDescriptor: { ...descriptor, cellAddress: '10.91.8.3' } };
  await assert.rejects(store.reserve({ ...second, permanentDescriptor: descriptor }),
    /Invalid AWG bootstrap state/);
  await assert.rejects(store.reserve({ ...second, cellAddress: descriptor.cellAddress }),
    /Invalid AWG bootstrap state/);
  await assert.rejects(store.reserve({ ...second, cellAddress: descriptor.controllerAddress }),
    /Invalid AWG bootstrap state/);
  await assert.rejects(store.reserve({ ...second, permanentDescriptor: {
    ...second.permanentDescriptor, endpointPort: 53085 } }), /Invalid AWG bootstrap state/);
  assert.equal((await store.read()).invitations.length, 1);
});

test('v2 registration durably binds a cell-owned permanent AWG key and PSK', async t => {
  const { store, controller, issued } = await fixture(t);
  await store.reserve(issued.record);
  await store.markReady(issued.record.id);
  const invitation = decodeAwgBootstrapInvitation(issued.code, 1001);
  const cell = identity();
  const permanent = { publicKey: key(), presharedKey: key() };
  const request = signAwgRegistration(invitation, cell.privateKey, permanent, 1002);
  const result = await store.completeAwgSigned(request, controller.publicKey, 1003);
  assert.equal(result.awgPublicKey, permanent.publicKey);
  assert.deepEqual(await store.completeAwgSigned(request, controller.publicKey, 1004), result);
  const saved = (await store.read()).invitations[0];
  assert.equal(saved.awgPublicKey, permanent.publicKey);
  assert.equal(saved.awgPresharedKey, permanent.presharedKey);
  await assert.rejects(store.completeAwgSigned(signAwgRegistration(invitation, cell.privateKey,
    { ...permanent, publicKey: key() }, 1005), controller.publicKey, 1006), /consumed/);
  await store.beginClose(issued.record.id);
  await store.markClosed(issued.record.id);
  const closed = (await store.read()).invitations[0];
  assert.equal(closed.temporaryPresharedKey, null);
  assert.equal(closed.awgPublicKey, permanent.publicKey);
});

test('v2 registration refuses reuse of the controller-generated temporary AWG key', async t => {
  const { store, controller, issued } = await fixture(t);
  await store.reserve(issued.record);
  await store.markReady(issued.record.id);
  const request = signAwgRegistration(decodeAwgBootstrapInvitation(issued.code, 1001),
    identity().privateKey, { publicKey: issued.record.temporaryPublicKey,
      presharedKey: key() }, 1002);
  await assert.rejects(store.completeAwgSigned(request, controller.publicKey, 1003), /unavailable/);
  assert.equal((await store.read()).invitations[0].status, 'pending');
});
