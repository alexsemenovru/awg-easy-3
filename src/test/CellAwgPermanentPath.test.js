'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile, renderInterfaceFields } = require('../lib/Awg3Config');
const { createAwgOwnership } = require('../lib/CellAwgOwnership');
const { CellAwgPermanentPath } = require('../lib/CellAwgPermanentPath');

const key = () => crypto.randomBytes(32).toString('base64');
function fixture() {
  const name = 'awgperm8';
  const config = `[Interface]\nPrivateKey = ${key()}\nListenPort = 53084\n`
    + `${renderInterfaceFields(generateOfficialProfile())}\n[Peer]\nPublicKey = ${key()}\n`
    + `PresharedKey = ${key()}\nAllowedIPs = 10.91.8.2/32\n`;
  const spec = { version: 1, owner: createAwgOwnership({ interfaceName: name, config }),
    addresses: ['10.91.8.1/32'] };
  const policy = { nftables: [{ table: { family: 'inet', name: 'awg_easy_3_routes' } }] };
  const routeCommands = [{ file: 'ip', args: ['-4', 'route', 'add', '10.91.8.2/32',
    'table', 'main', 'proto', '186', 'dev', name] }];
  let life = { phase: 'empty', spec: null }, awg = { committed: null, pending: null };
  let routes = { committed: [], pending: null }, firewall = { committed: null, pending: null };
  let currentPolicy = null, guarded = false, up = true, failPolicy = false;
  let foreignRoute = false;
  const events = [];
  const guard = {
    load: async () => ({ interfaces: guarded ? [name] : [], pending: null }),
    recover: async () => events.push('guard-recover'),
    protect: async () => { guarded = true; events.push('guard-protect'); },
    release: async check => {
      assert.equal(guarded, true);
      if (!await check()) throw new Error('Readback failed');
      guarded = false; events.push('guard-release');
    },
  };
  const lifecycle = {
    load: async () => structuredClone(life),
    create: async value => { assert.equal(guarded, true);
      life = { phase: 'creating', spec: value }; events.push('life-create'); },
    recover: async () => { assert.equal(guarded, true);
      life.phase = 'ready'; events.push('life-recover'); },
    verify: async value => { assert.deepEqual(value, spec); return { up }; },
  };
  const awgTransaction = {
    load: async () => structuredClone(awg),
    initialize: async value => { assert.equal(guarded, true);
      awg.committed = value; events.push('awg-init'); },
    recover: async () => { assert.equal(guarded, true); events.push('awg-recover'); },
    inspect: async () => { events.push('awg-inspect'); },
  };
  const routeTransaction = {
    load: async () => structuredClone(routes),
    recover: async () => { assert.equal(guarded, true); events.push('routes-recover'); },
    apply: async desired => { assert.equal(guarded, true);
      routes.committed = desired; events.push('routes-apply'); },
    inventory: async () => ({ routes4: routes.committed.length || foreignRoute
      ? [{ dst: '10.91.8.2', table: 'main', protocol: 'bgp', dev: name }] : [],
    routes6: [], rules4: [], rules6: [] }),
  };
  const nftTransaction = {
    normalize: value => structuredClone(value),
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    load: async () => structuredClone(firewall),
    recover: async () => { assert.equal(guarded, true); events.push('nft-recover'); },
    apply: async desired => { assert.equal(guarded, true); events.push('nft-apply');
      if (failPolicy) throw new Error('nft failed');
      firewall.committed = desired; currentPolicy = desired; },
    current: async () => structuredClone(currentPolicy),
  };
  const path = new CellAwgPermanentPath({ lifecycle, awg: awgTransaction,
    routes: routeTransaction, firewall: nftTransaction, guard, spec, policy, routeCommands });
  return { path, events, spec, get guarded() { return guarded; },
    setFailPolicy: value => { failPolicy = value; }, setUp: value => { up = value; },
    setAwg: value => { awg = value; }, setLife: value => { life = value; },
    setCurrentPolicy: value => { currentPolicy = value; },
    setForeignRoute: value => { foreignRoute = value; } };
}

test('permanent path installs under guard, verifies all children, then releases', async () => {
  const f = fixture();
  assert.deepEqual(await f.path.initialize(), { ready: true });
  assert.equal(f.guarded, false);
  assert.deepEqual(f.events.filter(event => ['guard-protect', 'life-create', 'awg-init',
    'routes-apply', 'nft-apply', 'guard-release'].includes(event)),
  ['guard-protect', 'life-create', 'awg-init', 'routes-apply', 'nft-apply', 'guard-release']);
  await assert.rejects(f.path.initialize(), /requires recovery/);
});

test('failed permanent policy retains guard and recovery resumes without replacing identity', async () => {
  const f = fixture(); f.setFailPolicy(true);
  await assert.rejects(f.path.initialize(), /nft failed/);
  assert.equal(f.guarded, true);
  f.setFailPolicy(false);
  assert.deepEqual(await f.path.recover(), { ready: true });
  assert.equal(f.guarded, false);
  assert.equal(f.events.filter(event => event === 'life-create').length, 1);
  assert.equal(f.events.filter(event => event === 'awg-init').length, 1);
});

test('foreign permanent ownership and failed readback never release guard', async () => {
  const changed = fixture();
  changed.setLife({ phase: 'ready', spec: { ...changed.spec, addresses: ['10.91.8.9/32'] } });
  await assert.rejects(changed.path.recover(), /differs from plan/);
  assert.equal(changed.events.length, 0);

  const down = fixture(); down.setUp(false);
  await assert.rejects(down.path.initialize(), /readback failed/);
  assert.equal(down.guarded, true);
  assert.ok(!down.events.includes('guard-release'));
});

test('first install refuses a foreign firewall or identical unjournaled route before mutation', async () => {
  const nft = fixture(); nft.setCurrentPolicy({ nftables: [] });
  await assert.rejects(nft.path.initialize(), /foreign child state/);
  assert.equal(nft.events.length, 0);

  const route = fixture(); route.setForeignRoute(true);
  await assert.rejects(route.path.initialize(), /foreign or conflicting route/);
  assert.equal(route.events.length, 0);
});
