'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { normalizeAwgConfig } = require('../lib/CellAwgSnapshot');
const { permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
const { joinPermanentCell, joinPermanentController } = require('../lib/CellAwgPermanentJoin');

const key = () => crypto.randomBytes(32).toString('base64');
function fixture() {
  const descriptor = { version: 1, endpointHost: '198.51.100.42', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey: key(), profile: generateOfficialProfile() };
  const connection = { status: 'registered', permanent: { privateKey: key(),
    presharedKey: key() }, controllerPath: descriptor };
  const record = { id: 'a'.repeat(32), status: 'consumed', phase: 'ready',
    permanentDescriptor: descriptor, cellAddress: '10.90.0.2',
    awgPublicKey: key(), awgPresharedKey: connection.permanent.presharedKey };
  let saved = null, ready = false, retired = 0;
  let journalInitialized = false;
  const initialRevisionStore = { initialize: async () => { journalInitialized = true; } };
  const deployment = { store: { read: async () => saved }, install: async (plan, options = {}) => {
    if (saved && saved.spec.owner.ownerTag !== plan.spec.owner.ownerTag) {
      throw new Error('identity changed');
    }
    if (options.beforeApply) {
      await options.beforeApply();
      assert.equal(journalInitialized, true);
    }
    saved ??= { ...plan, version: 1 };
  } };
  return { descriptor, connection, record, deployment, initialRevisionStore,
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
    keyManager: { derivePublicKey: async () => f.descriptor.serverPublicKey },
    initialRevisionStore: f.initialRevisionStore };
  assert.deepEqual(await joinPermanentController(args),
    { status: 'waiting-for-permanent-path', temporaryRetained: true });
  assert.equal(f.retired(), 0);
  f.setReady(true);
  assert.deepEqual(await joinPermanentController(args), { status: 'ready', temporaryRetained: false });
  assert.equal(f.retired(), 1);
});

test('controller join reserves one base when two cells registered before first join', async () => {
  const f = fixture();
  const second = { ...f.record, id: 'b'.repeat(32), cellAddress: '10.90.0.3',
    awgPublicKey: key(), awgPresharedKey: key(),
    permanentDescriptor: { ...f.descriptor, cellAddress: '10.91.8.3' } };
  const result = await joinPermanentController({
    bootstrapStore: { read: async () => ({ invitations: [f.record, second] }) },
    invitationId: second.id, deployment: f.deployment, gate: f.gate,
    coordinator: f.coordinator, interfaceName: 'awgperm8', privateKey: key(),
    keyManager: { derivePublicKey: async () => f.descriptor.serverPublicKey },
    initialRevisionStore: f.initialRevisionStore });
  assert.deepEqual(result, { status: 'waiting-for-permanent-path', temporaryRetained: true });
  const peers = normalizeAwgConfig(f.readSaved().spec.owner.config).peers;
  assert.equal(peers.length, 1);
  assert.equal(peers[0].publickey, second.awgPublicKey);
});

test('second cell uses guarded additive revision, then retires only its temporary peer', async () => {
  const f = fixture(), privateKey = key();
  const keyManager = { derivePublicKey: async () => f.descriptor.serverPublicKey };
  const base = { ...await permanentControllerPlan({ privateKey, descriptor: f.descriptor,
    peers: [{ cellAddress: f.record.permanentDescriptor.cellAddress,
      awgPublicKey: f.record.awgPublicKey,
      awgPresharedKey: f.record.awgPresharedKey }], interfaceName: 'awgperm8',
    keyManager }), version: 1 };
  const second = { ...f.record, id: 'b'.repeat(32), cellAddress: '10.90.0.3',
    awgPublicKey: key(), awgPresharedKey: key(),
    permanentDescriptor: { ...f.descriptor, cellAddress: '10.91.8.3' } };
  const deployment = { store: { read: async () => base },
    install: async () => { throw new Error('base installation must not run'); } };
  const revisionStore = {};
  let current = base, changes = 0, retired = 0, ready = false;
  const expansionRuntime = { deployment, revisionStore,
    recoverCurrent: async () => current,
    prepare: async plan => { current = plan; changes++; } };
  const gate = { revisionStore, verifyController: async () => ready };
  const args = { bootstrapStore: { read: async () => ({ invitations: [f.record, second] }) },
    invitationId: second.id, deployment, gate,
    coordinator: { close: async id => { assert.equal(id, second.id); retired++; } },
    interfaceName: 'awgperm8', privateKey, keyManager, expansionRuntime };
  assert.deepEqual(await joinPermanentController(args),
    { status: 'waiting-for-permanent-path', temporaryRetained: true });
  assert.equal(changes, 1); assert.equal(retired, 0);
  assert.equal(normalizeAwgConfig(current.spec.owner.config).peers.length, 2);
  ready = true;
  assert.deepEqual(await joinPermanentController(args),
    { status: 'ready', temporaryRetained: false });
  assert.equal(changes, 1); assert.equal(retired, 1);
  assert.equal(current.spec.owner.ownerTag, base.spec.owner.ownerTag);
});

test('second cell refuses a retirement gate not bound to the revision journal', async () => {
  const f = fixture(), privateKey = key();
  const keyManager = { derivePublicKey: async () => f.descriptor.serverPublicKey };
  const base = { ...await permanentControllerPlan({ privateKey, descriptor: f.descriptor,
    peers: [{ cellAddress: f.record.permanentDescriptor.cellAddress,
      awgPublicKey: f.record.awgPublicKey,
      awgPresharedKey: f.record.awgPresharedKey }], interfaceName: 'awgperm8',
    keyManager }), version: 1 };
  const second = { ...f.record, id: 'b'.repeat(32), cellAddress: '10.90.0.3',
    awgPublicKey: key(), awgPresharedKey: key(),
    permanentDescriptor: { ...f.descriptor, cellAddress: '10.91.8.3' } };
  const deployment = { store: { read: async () => base }, install: async () => {} };
  let attempted = false;
  await assert.rejects(joinPermanentController({
    bootstrapStore: { read: async () => ({ invitations: [f.record, second] }) },
    invitationId: second.id, deployment,
    gate: { verifyController: async () => true },
    coordinator: { close: async () => { attempted = true; } },
    interfaceName: 'awgperm8', privateKey, keyManager,
    expansionRuntime: { deployment, revisionStore: {},
      recoverCurrent: async () => { attempted = true; return base; },
      prepare: async () => { attempted = true; } },
  }), /revision-aware/);
  assert.equal(attempted, false);
});
