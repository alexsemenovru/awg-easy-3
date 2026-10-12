'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
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
  const plan = await permanentControllerPlan({ privateKey: key(), descriptor,
    peers: [{ cellAddress: descriptor.cellAddress, awgPublicKey: key(), awgPresharedKey: key() }],
    interfaceName: 'awgperm8', keyManager });
  await new CellAwgPermanentDeployment({ stateDirectory: directory }).store.reserve(plan);
  const runtime = await openPermanentControllerRuntime({ stateDirectory: directory, keyManager });
  assert.equal(runtime.expansionRuntime.deployment, runtime.deployment);
  assert.equal(runtime.expansionRuntime.revisionStore, runtime.revisionStore);
  assert.equal(runtime.gate.deployment, runtime.deployment);
  assert.equal(runtime.gate.revisionStore, runtime.revisionStore);
  assert.deepEqual(await runtime.revisionStore.read(), runtime.revisionStore.empty());
  await assert.rejects(runtime.join({ bootstrapStore: { read: async () => ({ invitations: [] }) },
    invitationId: 'a'.repeat(32), coordinator: { close: async () => {} },
    interfaceName: 'awgperm8', privateKey: key() }), /Consumed permanent cell invitation required/);
});
