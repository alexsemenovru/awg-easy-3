'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { joinPermanentCell, joinPermanentController } = require('../lib/CellAwgPermanentJoin');

const key = () => crypto.randomBytes(32).toString('base64');
function fixture() {
  const descriptor = { version: 1, endpointHost: '198.51.100.42', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey: key(), profile: generateOfficialProfile() };
  const connection = { status: 'registered', permanent: { privateKey: key(),
    presharedKey: key() }, controllerPath: descriptor };
  const record = { id: 'a'.repeat(32), status: 'consumed', phase: 'ready',
    permanentDescriptor: descriptor, cellAddress: descriptor.cellAddress,
    awgPublicKey: key(), awgPresharedKey: connection.permanent.presharedKey };
  let saved = null, ready = false, retired = 0;
  const deployment = { store: { read: async () => saved }, install: async plan => {
    if (saved && saved.spec.owner.ownerTag !== plan.spec.owner.ownerTag) {
      throw new Error('identity changed');
    }
    saved ??= { ...plan, version: 1 };
  } };
  return { descriptor, connection, record, deployment,
    setReady: value => { ready = value; }, readSaved: () => saved,
    gate: { verifyCell: async () => ready, verifyController: async () => ready },
    retirement: { retire: async () => { retired++; } },
    coordinator: { close: async id => { assert.equal(id, record.id); retired++; } },
    retired: () => retired };
}

test('cell join keeps temporary peer until the permanent proof passes and reuses plan', async () => {
  const f = fixture();
  const args = { connectionStore: { read: async () => f.connection },
    deployment: f.deployment, gate: f.gate, retirement: f.retirement,
    interfaceName: 'awgperm8' };
  assert.deepEqual(await joinPermanentCell(args),
    { status: 'waiting-for-permanent-path', temporaryRetained: true });
  const original = f.readSaved().spec.owner.ownerTag;
  f.setReady(true);
  assert.deepEqual(await joinPermanentCell(args), { status: 'ready', temporaryRetained: false });
  assert.equal(f.readSaved().spec.owner.ownerTag, original);
  assert.equal(f.retired(), 1);
});

test('controller join closes only the signed enrolled peer after permanent proof', async () => {
  const f = fixture();
  const args = { bootstrapStore: { read: async () => ({ invitations: [f.record] }) },
    invitationId: f.record.id, deployment: f.deployment, gate: f.gate,
    coordinator: f.coordinator, interfaceName: 'awgperm8', privateKey: key(),
    keyManager: { derivePublicKey: async () => f.descriptor.serverPublicKey } };
  assert.deepEqual(await joinPermanentController(args),
    { status: 'waiting-for-permanent-path', temporaryRetained: true });
  assert.equal(f.retired(), 0);
  f.setReady(true);
  assert.deepEqual(await joinPermanentController(args), { status: 'ready', temporaryRetained: false });
  assert.equal(f.retired(), 1);
});

test('controller join explicitly rejects a second simultaneous consumed invitation', async () => {
  const f = fixture();
  const second = { ...f.record, id: 'b'.repeat(32), cellAddress: '10.91.8.3' };
  await assert.rejects(joinPermanentController({
    bootstrapStore: { read: async () => ({ invitations: [f.record, second] }) },
    invitationId: f.record.id, deployment: f.deployment, gate: f.gate,
    coordinator: f.coordinator, interfaceName: 'awgperm8', privateKey: key() }), /Multi-cell/);
  assert.equal(f.readSaved(), null);
});
