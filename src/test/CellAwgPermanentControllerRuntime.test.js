'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
const { permanentControllerExpansionPlan } = require('../lib/CellAwgPermanentExpansionPlan');
const { CellAwgPermanentDeployment } = require('../lib/CellAwgPermanentDeployment');
const { openPermanentControllerRuntime } = require('../lib/CellAwgPermanentControllerRuntime');

const key = () => crypto.randomBytes(32).toString('base64');

test('controller assembly opens only a reserved base and shares one revision journal', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-control-assembly-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(openPermanentControllerRuntime({ stateDirectory: directory }),
    /base plan is not reserved/);
  const serverPublicKey = key();
  const descriptor = { version: 1, endpointHost: '198.51.100.42', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey, profile: generateOfficialProfile() };
  const keyManager = { derivePublicKey: async () => serverPublicKey };
  const first = { status: 'consumed', cellAddress: descriptor.cellAddress,
    awgPublicKey: key(), awgPresharedKey: key(), permanentDescriptor: descriptor };
  const plan = await permanentControllerPlan({ privateKey: key(), descriptor,
    peers: [{ cellAddress: first.cellAddress, awgPublicKey: first.awgPublicKey,
      awgPresharedKey: first.awgPresharedKey }],
    interfaceName: 'awgperm8', keyManager });
  const original = new CellAwgPermanentDeployment({ stateDirectory: directory });
  await original.store.reserve(plan);
  let baseOperational = false, guarded = false;
  const deployment = { stateDirectory: directory, runner: async () => {},
    store: original.store, install: async () => {},
    resume: async () => { assert.equal(guarded, true);
      if (!baseOperational) throw new Error('expanded state differs from base');
      guarded = false; },
    buildPath: () => ({ protect: async () => { guarded = true; },
      verifyOperational: async () => baseOperational && !guarded }) };
  await assert.rejects(openPermanentControllerRuntime({ stateDirectory: directory,
    keyManager, deployment }), /Missing permanent revision journal; base recovery failed/);
  assert.equal(guarded, true);
  baseOperational = true;
  const runtime = await openPermanentControllerRuntime({ stateDirectory: directory,
    keyManager, deployment });
  assert.equal(runtime.expansionRuntime.deployment, runtime.deployment);
  assert.equal(runtime.expansionRuntime.revisionStore, runtime.revisionStore);
  assert.equal(runtime.gate.deployment, runtime.deployment);
  assert.equal(runtime.gate.revisionStore, runtime.revisionStore);
  assert.deepEqual(await runtime.revisionStore.read(), runtime.revisionStore.empty());
  await assert.rejects(runtime.join({ bootstrapStore: { read: async () => ({ invitations: [] }) },
    invitationId: 'a'.repeat(32), coordinator: { close: async () => {} },
    interfaceName: 'awgperm8', privateKey: key() }), /Consumed permanent cell invitation required/);
  const second = { status: 'consumed', cellAddress: '10.91.8.3',
    awgPublicKey: key(), awgPresharedKey: key(), permanentDescriptor: {
      ...descriptor, cellAddress: '10.91.8.3' } };
  const expanded = await permanentControllerExpansionPlan({ currentPlan: { ...plan, version: 1 },
    records: [first, second], keyManager });
  await runtime.revisionStore.prepare(expanded);
  await runtime.revisionStore.commit();
  await fs.unlink(runtime.revisionStore.filePath);
  baseOperational = false;
  guarded = false;
  await assert.rejects(openPermanentControllerRuntime({ stateDirectory: directory,
    keyManager, deployment }), /Missing permanent revision journal; base recovery failed/);
  assert.equal(guarded, true);
  await assert.rejects(fs.lstat(runtime.revisionStore.filePath), { code: 'ENOENT' });
});
