'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { permanentCellPlan } = require('../lib/CellAwgPermanentPlan');
const { CellAwgPermanentDeployment, permanentPathFromPlan } = require('../lib/CellAwgPermanentDeployment');

const key = () => crypto.randomBytes(32).toString('base64');
function plan() {
  return permanentCellPlan({ interfaceName: 'awgperm8', connection: { status: 'registered',
    permanent: { privateKey: key(), presharedKey: key() }, controllerPath: {
      version: 1, endpointHost: '198.51.100.42', endpointPort: 53084,
      controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
      serverPublicKey: key(), profile: generateOfficialProfile(),
    } } });
}

test('deployment resumes the same durable plan after interrupted first creation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-deploy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const events = [], original = plan();
  let phase = 'empty', first = true;
  const buildPath = ({ plan: saved }) => ({
    lifecycle: { load: async () => ({ phase }) },
    initialize: async () => {
      events.push(saved.spec.owner.ownerTag);
      phase = 'creating';
      if (first) { first = false; throw new Error('injected interruption'); }
      return { ready: true };
    },
    recover: async () => { events.push(saved.spec.owner.ownerTag); phase = 'ready';
      return { ready: true }; },
  });
  const deployment = new CellAwgPermanentDeployment({ stateDirectory: dir, buildPath });
  await assert.rejects(deployment.install({ ...original, version: 2 }), /version/);
  await assert.rejects(deployment.install(original), /interruption/);
  assert.deepEqual(await deployment.resume(), { ready: true });
  assert.deepEqual(events, [original.spec.owner.ownerTag, original.spec.owner.ownerTag]);
  await assert.rejects(deployment.install(plan()), /Different/);
  assert.equal((await deployment.store.read()).spec.owner.ownerTag, original.spec.owner.ownerTag);
});

test('runtime wiring uses dedicated guarded journals for a saved permanent plan', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-runtime-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = permanentPathFromPlan({ stateDirectory: dir, plan: { ...plan(), version: 1 } });
  assert.equal(runtime.guard.table, 'awg_easy_3_control_guard');
  assert.equal(runtime.firewall.table, 'awg_easy_3_control');
  assert.equal(runtime.interfaceName, 'awgperm8');
  assert.equal(path.dirname(runtime.lifecycle.file), dir);
  assert.equal(path.dirname(runtime.awg.file), dir);
});
