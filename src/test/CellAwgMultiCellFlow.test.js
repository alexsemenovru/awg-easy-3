'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { createAwgBootstrapInvitation, decodeAwgBootstrapInvitation } =
  require('../lib/CellAwgBootstrapInvitation');
const { CellAwgBootstrapStore } = require('../lib/CellAwgBootstrapStore');
const { CellAwgRegistrationService } = require('../lib/CellAwgRegistrationService');
const { signAwgRegistration } = require('../lib/CellAwgRegistration');
const { identity } = require('../lib/CellRegistration');
const { permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
const { permanentControllerExpansionPlan } = require('../lib/CellAwgPermanentExpansionPlan');
const { normalizeAwgConfig } = require('../lib/CellAwgSnapshot');

const key = () => crypto.randomBytes(32).toString('base64');

test('two signed registrations compile one additive permanent controller path', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-two-cells-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identities = new ControlIdentityStore(path.join(directory, 'identity.json'));
  const controller = await identities.create('controller');
  const store = new CellAwgBootstrapStore(path.join(directory, 'bootstrap.json'));
  const registration = new CellAwgRegistrationService(identities, store);
  const serverPublicKey = key(), privateKey = key(), profile = generateOfficialProfile();
  const keyManager = { derivePublicKey: async () => serverPublicKey };
  const records = [];
  for (const index of [2, 3]) {
    const descriptor = { version: 1, endpointHost: '198.51.100.42',
      endpointPort: 53084, controllerAddress: '10.91.8.1',
      cellAddress: `10.91.8.${index}`, controlPort: 53083,
      serverPublicKey, profile };
    const issued = await createAwgBootstrapInvitation({ controllerKey: controller.publicKey,
      endpointHost: '198.51.100.42', endpointPort: 53082,
      registrationPort: 53081, controllerAddress: '10.90.0.1',
      cellAddress: `10.90.0.${index}`, serverPublicKey, permanentDescriptor: descriptor,
      profile, keyManager: { generatePeerKeys: async () => ({
        privateKey: key(), publicKey: key(), presharedKey: key() }) } });
    await store.reserve(issued.record);
    await store.markReady(issued.record.id);
    const invitation = decodeAwgBootstrapInvitation(issued.code);
    const request = signAwgRegistration(invitation, identity().privateKey,
      { publicKey: key(), presharedKey: key() });
    const receipt = await registration.register(request);
    assert.deepEqual(receipt.permanent, descriptor);
    records.push((await store.read()).invitations.find(item => item.id === issued.record.id));
  }
  assert.ok(records.every(record => record.status === 'consumed'
    && record.phase === 'ready' && record.permanentDescriptor));
  const first = records[0];
  const base = { ...await permanentControllerPlan({ privateKey,
    descriptor: first.permanentDescriptor, interfaceName: 'awgperm8', keyManager,
    peers: [{ cellAddress: first.permanentDescriptor.cellAddress,
      awgPublicKey: first.awgPublicKey, awgPresharedKey: first.awgPresharedKey }] }),
  version: 1 };
  const expanded = await permanentControllerExpansionPlan({ currentPlan: base,
    records, keyManager });
  const before = normalizeAwgConfig(base.spec.owner.config).peers;
  const after = normalizeAwgConfig(expanded.spec.owner.config).peers;
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
  assert.ok(after.some(peer => peer.publickey === before[0].publickey));
  assert.equal(expanded.spec.owner.ownerTag, base.spec.owner.ownerTag);
});
