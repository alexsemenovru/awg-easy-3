'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { permanentCellPlan } = require('../lib/CellAwgPermanentPlan');
const { CellAwgPermanentPlanStore, validatePermanentPlan } = require('../lib/CellAwgPermanentPlanStore');

const key = () => crypto.randomBytes(32).toString('base64');
function plan() {
  const descriptor = { version: 1, endpointHost: '198.51.100.42', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey: key(), profile: generateOfficialProfile() };
  return permanentCellPlan({ interfaceName: 'awgperm8', connection: {
    status: 'registered', permanent: { privateKey: key(), presharedKey: key() },
    controllerPath: descriptor } });
}

test('private permanent plan is durably reserved once and restored unchanged', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-plan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'private', 'permanent.json');
  const store = new CellAwgPermanentPlanStore(file);
  assert.equal(await store.read(), null);
  const original = plan();
  await assert.rejects(store.reserve({ ...original, version: 2 }), /version/);
  const saved = await store.reserve(original);
  assert.deepEqual(await store.read(), saved);
  await assert.rejects(store.reserve(plan()), { code: 'EEXIST' });
  assert.deepEqual(await store.read(), saved);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o077, 0);
});

test('plan rejects foreign policy, route interface and corrupt existing file', async t => {
  const original = plan();
  assert.throws(() => validatePermanentPlan({ ...original, version: 1,
    policy: { nftables: [{ table: { family: 'inet', name: 'filter' } }] } }), /Invalid|Foreign/);
  const foreign = structuredClone(original);
  foreign.routeCommands[0].args[foreign.routeCommands[0].args.length - 1] = 'eth0';
  assert.throws(() => validatePermanentPlan({ ...foreign, version: 1 }), /another interface/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-plan-corrupt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'permanent.json');
  await fs.writeFile(file, '{corrupt');
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
  const store = new CellAwgPermanentPlanStore(file);
  await assert.rejects(store.read(), /Unreadable/);
  await assert.rejects(store.reserve(original), { code: 'EEXIST' });
});
