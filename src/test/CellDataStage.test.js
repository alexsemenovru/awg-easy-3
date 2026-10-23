'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellAwgPermanentDeployment } = require('../lib/CellAwgPermanentDeployment');
const { cellDataLinkPlan } = require('../lib/CellDataLinkPlan');
const { stageCellDataPlan } = require('../lib/CellDataStage');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const key = n => Buffer.alloc(32, n).toString('base64');
const offer = () => ({ version: 1, presharedKey: key(3), descriptor: {
  version: 1, slot: 0, endpointHost: '198.51.100.4', endpointPort: 53000,
  controllerAddress4: '10.252.0.1', cellAddress4: '10.252.0.2',
  controllerPublicKey: key(2), controllerClientSubnet4: '10.8.0.0/24',
  cellClientSubnet4: '10.88.0.0/24', profile: generateOfficialProfile(),
} });

test('data stage reserves one exact guarded plan and recovers its original ownership', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-data-stage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let phase = 'empty';
  const options = { stateDirectory: directory, policyTable: 'awg_easy_3_data_cell',
    guardTable: 'awg_easy_3_data_guard_cell', retainGuard: true,
    buildPath: ({ plan }) => ({ lifecycle: { load: async () => ({ phase }) },
      initialize: async () => { phase = 'ready'; return { ready: true, guarded: true,
        ownerTag: plan.spec.owner.ownerTag };
      },
      recover: async () => ({ ready: true, guarded: true,
        ownerTag: plan.spec.owner.ownerTag }) }) };
  const deployment = new CellAwgPermanentDeployment(options), input = offer();
  const first = cellDataLinkPlan({ offer: input, privateKey: key(5) });
  const created = await stageCellDataPlan({ deployment, expected: first });
  assert.equal(created.created, true); assert.equal(created.guarded, true);
  const second = cellDataLinkPlan({ offer: input, privateKey: key(5) });
  assert.notEqual(first.plan.spec.owner.ownerTag, second.plan.spec.owner.ownerTag);
  const reused = await stageCellDataPlan({ deployment, expected: second });
  assert.equal(reused.created, false);
  assert.equal(reused.ownerTag, created.ownerTag);
  await assert.rejects(stageCellDataPlan({ deployment, expected: cellDataLinkPlan({
    offer: { ...input, presharedKey: key(9) }, privateKey: key(5),
  }) }), /explicit transition/);
});
