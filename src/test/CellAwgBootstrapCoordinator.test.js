'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { identity, signRegistration } = require('../lib/CellRegistration');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { CellAwgBootstrapStore } = require('../lib/CellAwgBootstrapStore');
const { CellAwgBootstrapCoordinator } = require('../lib/CellAwgBootstrapCoordinator');
const { createAwgBootstrapInvitation, decodeAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');

const key = () => crypto.randomBytes(32).toString('base64');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-bootstrap-coordinator-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new CellAwgBootstrapStore(path.join(directory, 'state.json'));
  const controller = identity();
  const temporaryKeys = { privateKey: key(), publicKey: key(), presharedKey: key() };
  const options = { controllerKey: controller.publicKey, endpointHost: 'example.test',
    endpointPort: 51820, registrationPort: 51822, controllerAddress: '10.90.0.1',
    cellAddress: '10.90.0.2', serverPublicKey: key(), profile: generateOfficialProfile(),
    keyManager: { generatePeerKeys: async () => temporaryKeys }, now: 1000 };
  const events = [];
  let installed = true, permanent = false;
  const runtime = {
    installPeer: async record => { events.push(`install:${record.id}`); },
    verifyPeer: async record => { events.push(`verify:${record.id}`); return installed; },
    removePeer: async record => { events.push(`remove:${record.id}`); },
    verifyPermanent: async record => { events.push(`permanent:${record.id}`); return permanent; },
  };
  const coordinator = new CellAwgBootstrapCoordinator({ store, runtime, now: () => 1002 });
  return { store, controller, options, events, coordinator,
    setInstalled: value => { installed = value; }, setPermanent: value => { permanent = value; } };
}

test('code is returned only after durable reservation, peer install and readback', async t => {
  const f = await fixture(t);
  const code = await f.coordinator.issue(f.options);
  const invite = decodeAwgBootstrapInvitation(code, 1001);
  const record = (await f.store.read()).invitations[0];
  assert.equal(record.phase, 'ready');
  assert.deepEqual(f.events, [`install:${record.id}`, `verify:${record.id}`]);
  const request = signRegistration(invite, identity().privateKey, 1002);
  await f.store.completeSigned(request, f.controller.publicKey, 1003);
  await assert.rejects(f.coordinator.close(record.id), /Permanent cell path not verified/);
  assert.equal((await f.store.read()).invitations[0].phase, 'ready');
  f.setPermanent(true);
  await f.coordinator.close(record.id);
  assert.equal((await f.store.read()).invitations[0].phase, 'closed');
  assert.equal(f.events.at(-1), `remove:${record.id}`);
});

test('failed peer readback never issues a code and removes the reserved peer', async t => {
  const f = await fixture(t);
  f.setInstalled(false);
  await assert.rejects(f.coordinator.issue(f.options), /no invitation was issued/);
  const record = (await f.store.read()).invitations[0];
  assert.equal(record.status, 'revoked');
  assert.equal(record.phase, 'closed');
  assert.equal(f.events.at(-1), `remove:${record.id}`);
});

test('recovery closes a preparation interrupted before code display', async t => {
  const f = await fixture(t);
  const issued = await createAwgBootstrapInvitation(f.options);
  await f.store.reserve(issued.record);
  await f.coordinator.recover();
  assert.equal((await f.store.read()).invitations[0].phase, 'closed');
  assert.equal(f.events.at(-1), `remove:${issued.record.id}`);
});
