'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { controllerDataLinkPlan, cellDataLinkPlan } = require('../lib/CellDataLinkPlan');
const { CellAwgPermanentDeployment, permanentPathFromPlan } = require('../lib/CellAwgPermanentDeployment');
const { validatePermanentPlan } = require('../lib/CellAwgPermanentPlanStore');
const { normalizeAwgConfig } = require('../lib/CellAwgSnapshot');

const key = n => Buffer.alloc(32, n).toString('base64');
const storedOffer = () => ({ version: 1, controllerPrivateKey: key(1),
  cellPublicKey: key(4), presharedKey: key(3),
  descriptor: { version: 1, endpointHost: 'main.example.test', endpointPort: 53000,
    controllerAddress4: '10.252.0.1', cellAddress4: '10.252.0.2',
    controllerPublicKey: key(2), controllerClientSubnet4: '10.8.0.0/24',
    cellClientSubnet4: '10.88.0.0/24', profile: generateOfficialProfile() } });

test('Main and Cell data plans use separate identities, route only peer hosts and stay guarded', async t => {
  const stored = storedOffer();
  const main = await controllerDataLinkPlan({ storedOffer: stored, slot: 0,
    keyManager: { derivePublicKey: async () => key(2) } });
  const cell = cellDataLinkPlan({ offer: { version: 1, descriptor: stored.descriptor,
    presharedKey: stored.presharedKey }, privateKey: key(5),
  resolvedEndpointHost: '198.51.100.42' });
  assert.equal(main.plan.spec.owner.interfaceName, 'awgd0');
  assert.equal(cell.plan.spec.owner.interfaceName, 'awgdata0');
  assert.equal(main.guardTable, 'awg_easy_3_data_guard_0');
  assert.equal(cell.guardTable, 'awg_easy_3_data_guard_cell');
  assert.ok(main.retainGuard && cell.retainGuard);
  assert.deepEqual(main.plan.routeCommands[0].args.slice(0, 5),
    ['-4', 'route', 'add', '10.252.0.2/32', 'table']);
  assert.ok(main.plan.routeCommands.every(command => !command.args.includes('default')));
  assert.ok(cell.plan.routeCommands.every(command => !command.args.includes('default')));
  assert.deepEqual(normalizeAwgConfig(cell.plan.spec.owner.config).peers[0].allowedips,
    ['0.0.0.0/0', '10.252.0.1/32']);
  assert.ok(!cell.plan.spec.owner.config.includes(key(1)));
  assert.ok(!main.plan.spec.owner.config.includes(key(5)));

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-data-plan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const deployment = new CellAwgPermanentDeployment({ stateDirectory: directory,
    policyTable: main.policyTable, guardTable: main.guardTable, retainGuard: true,
    buildPath: () => ({ lifecycle: { load: async () => ({ phase: 'empty' }) },
      initialize: async () => ({ ready: true, guarded: true }), recover: async () => {} }) });
  assert.deepEqual(await deployment.install(main.plan), { ready: true, guarded: true });
  assert.equal((await deployment.store.read()).spec.owner.interfaceName, 'awgd0');
  const runtime = permanentPathFromPlan({ stateDirectory: directory, plan: main.plan,
    policyTable: main.policyTable, guardTable: main.guardTable, retainGuard: true });
  assert.equal(runtime.guard.table, main.guardTable);
  assert.equal(runtime.firewall.table, main.policyTable);
  assert.equal(runtime.retainGuard, true);
});

test('data plans reject unknown slots, DNS endpoints without resolution and mismatched nft tables', async () => {
  const stored = storedOffer();
  await assert.rejects(controllerDataLinkPlan({ storedOffer: stored, slot: 127,
    keyManager: { derivePublicKey: async () => key(2) } }), /slot/);
  assert.throws(() => cellDataLinkPlan({ offer: { version: 1,
    descriptor: stored.descriptor, presharedKey: stored.presharedKey },
    privateKey: key(5) }), /literal/);
  assert.throws(() => new CellAwgPermanentDeployment({ stateDirectory: os.tmpdir(),
    policyTable: 'awg_easy_3_data_0', guardTable: 'awg_easy_3_control_guard',
    retainGuard: true }), /pairing/);
  const main = await controllerDataLinkPlan({ storedOffer: stored, slot: 0,
    keyManager: { derivePublicKey: async () => key(2) } });
  assert.throws(() => validatePermanentPlan(main.plan,
    { policyTable: 'awg_easy_3_data_127' }), /policy table/);
});
