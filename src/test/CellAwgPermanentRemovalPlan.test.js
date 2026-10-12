'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
const { permanentControllerExpansionPlan } = require('../lib/CellAwgPermanentExpansionPlan');
const { permanentControllerRemovalPlan } = require('../lib/CellAwgPermanentRemovalPlan');
const { normalizeAwgConfig } = require('../lib/CellAwgSnapshot');

const key = () => crypto.randomBytes(32).toString('base64');
async function fixture() {
  const serverPublicKey = key(), privateKey = key();
  const descriptor = { version: 1, endpointHost: '198.51.100.42', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey, profile: generateOfficialProfile() };
  const first = { status: 'consumed', cellAddress: '10.90.0.2', awgPublicKey: key(),
    awgPresharedKey: key(), permanentDescriptor: descriptor };
  const second = { status: 'consumed', cellAddress: '10.90.0.3', awgPublicKey: key(),
    awgPresharedKey: key(), permanentDescriptor: { ...descriptor, cellAddress: '10.91.8.3' } };
  const keyManager = { derivePublicKey: async () => serverPublicKey };
  const base = { version: 1, ...await permanentControllerPlan({ privateKey, descriptor,
    peers: [{ cellAddress: descriptor.cellAddress, awgPublicKey: first.awgPublicKey,
      awgPresharedKey: first.awgPresharedKey }], interfaceName: 'awgperm8', keyManager }) };
  const expanded = await permanentControllerExpansionPlan({ currentPlan: base,
    records: [first, second], keyManager });
  return { base, expanded, first, second, keyManager };
}

test('removal plan keeps other peer and controller identity', async () => {
  const f = await fixture();
  const reduced = await permanentControllerRemovalPlan({ currentPlan: f.expanded,
    record: f.second, keyManager: f.keyManager });
  assert.equal(reduced.spec.owner.ownerTag, f.base.spec.owner.ownerTag);
  assert.deepEqual(normalizeAwgConfig(reduced.spec.owner.config),
    normalizeAwgConfig(f.base.spec.owner.config));
  assert.deepEqual(reduced.policy, f.base.policy);
  assert.deepEqual(reduced.routeCommands, f.base.routeCommands);
  assert.equal(normalizeAwgConfig(reduced.spec.owner.config).peers.length, 1);
});

test('removal plan can leave a guarded controller with no cells', async () => {
  const f = await fixture();
  const empty = await permanentControllerRemovalPlan({ currentPlan: f.base,
    record: f.first, keyManager: f.keyManager });
  assert.equal(normalizeAwgConfig(empty.spec.owner.config).peers.length, 0);
  assert.deepEqual(empty.routeCommands, []);
  assert.equal(empty.spec.owner.ownerTag, f.base.spec.owner.ownerTag);
});

test('removal rejects wrong peer, changed descriptor and drifted policy', async () => {
  const f = await fixture();
  const args = { currentPlan: f.expanded, record: f.second, keyManager: f.keyManager };
  await assert.rejects(permanentControllerRemovalPlan({ ...args,
    record: { ...f.second, awgPresharedKey: key() } }), /identity/);
  await assert.rejects(permanentControllerRemovalPlan({ ...args,
    record: { ...f.second, permanentDescriptor: { ...f.second.permanentDescriptor,
      profile: generateOfficialProfile() } } }), /topology/);
  await assert.rejects(permanentControllerRemovalPlan({ ...args,
    currentPlan: { ...f.expanded, policy: f.base.policy } }), /topology/);
});
