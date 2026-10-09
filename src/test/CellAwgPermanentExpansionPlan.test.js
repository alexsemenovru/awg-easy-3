'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
const { permanentControllerExpansionPlan } = require('../lib/CellAwgPermanentExpansionPlan');
const { normalizeAwgConfig } = require('../lib/CellAwgSnapshot');

const key = () => crypto.randomBytes(32).toString('base64');
async function fixture() {
  const serverPublicKey = key(), privateKey = key();
  const descriptor = { version: 1, endpointHost: '198.51.100.42', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey, profile: generateOfficialProfile() };
  const first = { status: 'consumed', cellAddress: '10.91.8.2',
    awgPublicKey: key(), awgPresharedKey: key(), permanentDescriptor: descriptor };
  const second = { status: 'consumed', cellAddress: '10.91.8.3',
    awgPublicKey: key(), awgPresharedKey: key(), permanentDescriptor: {
      ...descriptor, cellAddress: '10.91.8.3' } };
  const keyManager = { derivePublicKey: async () => serverPublicKey };
  const initial = await permanentControllerPlan({ privateKey, descriptor,
    peers: [{ cellAddress: first.cellAddress, awgPublicKey: first.awgPublicKey,
      awgPresharedKey: first.awgPresharedKey }], interfaceName: 'awgperm8', keyManager });
  return { initial: { ...initial, version: 1 }, first, second, keyManager };
}

test('expansion adds exactly one signed peer without changing server identity or first peer', async () => {
  const f = await fixture();
  const expanded = await permanentControllerExpansionPlan({ currentPlan: f.initial,
    records: [f.first, f.second], keyManager: f.keyManager });
  assert.equal(expanded.spec.owner.ownerTag, f.initial.spec.owner.ownerTag);
  const before = normalizeAwgConfig(f.initial.spec.owner.config);
  const after = normalizeAwgConfig(expanded.spec.owner.config);
  assert.deepEqual(after.interface, before.interface);
  assert.ok(after.peers.some(peer => peer.publickey === f.first.awgPublicKey));
  assert.ok(after.peers.some(peer => peer.publickey === f.second.awgPublicKey));
  assert.equal(expanded.routeCommands.length, 2);
  assert.equal(expanded.policy.nftables.filter(item => item.rule).length, 10);
  assert.deepEqual(await permanentControllerExpansionPlan({ currentPlan: expanded,
    records: [f.second, f.first], keyManager: f.keyManager }), expanded);
});

test('expansion refuses changed old peer, changed protocol profile and skipped peer', async () => {
  const f = await fixture();
  const args = { currentPlan: f.initial, records: [f.first, f.second],
    keyManager: f.keyManager };
  await assert.rejects(permanentControllerExpansionPlan({ ...args,
    records: [{ ...f.first, awgPresharedKey: key() }, f.second] }), /changes existing/);
  await assert.rejects(permanentControllerExpansionPlan({ ...args,
    records: [f.first, { ...f.second, permanentDescriptor: {
      ...f.second.permanentDescriptor, profile: generateOfficialProfile() } }] }), /disagree/);
  await assert.rejects(permanentControllerExpansionPlan({ ...args,
    records: [f.second] }), /changes existing/);
  const third = { ...f.second, cellAddress: '10.91.8.4', awgPublicKey: key(),
    permanentDescriptor: { ...f.second.permanentDescriptor, cellAddress: '10.91.8.4' } };
  await assert.rejects(permanentControllerExpansionPlan({ ...args,
    records: [f.first, f.second, third] }), /changes existing/);
});
