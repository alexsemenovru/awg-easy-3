'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile, renderInterfaceFields } = require('../lib/Awg3Config');
const { createAwgOwnership } = require('../lib/CellAwgOwnership');
const { CellAwgPermanentPath } = require('../lib/CellAwgPermanentPath');

const key = () => crypto.randomBytes(32).toString('base64');
function fixture({ retainGuard = false } = {}) {
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
  let currentPolicy = null, guarded = false, lingeringGuard = false, up = true, failPolicy = false;
  let foreignRoute = false;
  const events = [];
  const guard = {
    load: async () => ({ interfaces: guarded ? [name] : [], pending: null }),
    current: async () => guarded || lingeringGuard ? { nftables: [] } : null,
    recover: async () => events.push('guard-recover'),
    protect: async () => { guarded = true; events.push('guard-protect'); },
    release: async check => {
      assert.equal(guarded, true);
      if (!await check()) throw new Error('Readback failed');
      guarded = false; events.push('guard-release');
    },
  };
  const lifecycle = {
    link: async () => life.phase === 'empty' ? null : { ifname: name },
    finishRemoval: async saved => { assert.deepEqual(saved.spec, spec);
      life = { phase: 'empty', spec: null }; events.push('life-remove'); },
    load: async () => structuredClone(life),
    create: async value => { assert.equal(guarded, true);
      life = { phase: 'creating', spec: value }; events.push('life-create'); },
    recover: async () => { assert.equal(guarded, true);
      life.phase = 'ready'; events.push('life-recover'); },
    verify: async value => { assert.deepEqual(value, spec); return { up }; },
  };
  const awgTransaction = {
    retire: async () => { assert.equal(life.phase, 'empty'); awg = { committed: null, pending: null }; },
    load: async () => structuredClone(awg),
    initialize: async value => { assert.equal(guarded, true);
      awg.committed = value; events.push('awg-init'); },
    recover: async () => { assert.equal(guarded, true); events.push('awg-recover'); },
    inspect: async () => { events.push('awg-inspect'); },
  };
  const routeTransaction = {
    reconcile: async (_before, desired) => { assert.deepEqual(desired, []); assert.equal(guarded, true); },
    save: async value => { routes = value; },
    load: async () => structuredClone(routes),
    recover: async () => { assert.equal(guarded, true); events.push('routes-recover'); },
    apply: async desired => { assert.equal(guarded, true);
      routes.committed = desired; events.push('routes-apply'); },
    inventory: async () => ({ routes4: routes.committed.length || foreignRoute
      ? [{ dst: '10.91.8.2', table: 'main', protocol: 'bgp', dev: name }] : [],
    routes6: [], rules4: [], rules6: [] }),
  };
  const nftTransaction = {
    candidates: value => [value.committed, ...(value.pending ? [value.pending.desired] : [])],
    reconcile: async (candidates, desired) => {
      if (failPolicy || !candidates.some(value => JSON.stringify(value) === JSON.stringify(currentPolicy))) throw new Error('Foreign nft policy');
      assert.equal(guarded, true); currentPolicy = desired;
    },
    save: async value => { firewall = value; },
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
    routes: routeTransaction, firewall: nftTransaction, guard, spec, policy, routeCommands,
    retainGuard });
  return { path, events, spec, get guarded() { return guarded; },
    setFailPolicy: value => { failPolicy = value; }, setUp: value => { up = value; },
    setAwg: value => { awg = value; }, setLife: value => { life = value; },
    setLingeringGuard: value => { lingeringGuard = value; },
    setCurrentPolicy: value => { currentPolicy = value; },
    setForeignRoute: value => { foreignRoute = value; } };
}

test('permanent path installs under guard, verifies all children, then releases', async () => {
  const f = fixture();
  assert.deepEqual(await f.path.initialize(), { ready: true });
  assert.equal(f.guarded, false);
  assert.equal(await f.path.verifyOperational(), true);
  f.setLingeringGuard(true);
  assert.equal(await f.path.verifyOperational(), false);
  f.setLingeringGuard(false);
  assert.deepEqual(f.events.filter(event => ['guard-protect', 'life-create', 'awg-init',
    'routes-apply', 'nft-apply', 'guard-release'].includes(event)),
  ['guard-protect', 'life-create', 'awg-init', 'routes-apply', 'nft-apply', 'guard-release']);
  await assert.rejects(f.path.initialize(), /requires recovery/);
});

test('failed permanent policy retains guard and recovery resumes without replacing identity', async () => {
  const f = fixture(); f.setFailPolicy(true);
  await assert.rejects(f.path.initialize(), /nft failed/);
  assert.equal(f.guarded, true);
  assert.equal(await f.path.verifyOperational(), false);
  f.setFailPolicy(false);
  assert.deepEqual(await f.path.recover(), { ready: true });
  assert.equal(f.guarded, false);
  assert.equal(f.events.filter(event => event === 'life-create').length, 1);
  assert.equal(f.events.filter(event => event === 'awg-init').length, 1);
});

test('data path stays guarded across recovery until a separate routing verifier passes', async () => {
  const f = fixture({ retainGuard: true });
  assert.deepEqual(await f.path.initialize(), { ready: true, guarded: true });
  assert.equal(f.guarded, true);
  assert.equal(await f.path.verifyOperational(), false);
  assert.deepEqual(await f.path.recover(), { ready: true, guarded: true });
  assert.equal(f.guarded, true);
  await assert.rejects(f.path.releaseAfterRouting(async () => false), /Runtime not verified|Readback failed/);
  assert.equal(f.guarded, true);
  assert.deepEqual(await f.path.releaseAfterRouting(async () => true),
    { ready: true, guarded: false });
  assert.equal(await f.path.verifyOperational(), true);
  assert.equal(f.events.filter(event => event === 'guard-release').length, 1);
});

test('non-data path cannot release guard through routing override', async () => {
  const f = fixture();
  await assert.rejects(f.path.releaseAfterRouting(async () => true), /Guarded data path/);
});

test('terminal path deletion is idempotent and does not reconstruct a disappeared tunnel', async () => {
  const f = fixture(); await f.path.initialize();
  await f.path.remove(); await f.path.remove();
  assert.equal(f.guarded, false);
  assert.equal(f.events.filter(event => event === 'life-remove').length, 1);
  assert.equal(f.events.filter(event => event === 'life-create').length, 1);
});

test('terminal deletion rejects a foreign kernel policy and retains its guard', async () => {
  const f = fixture(); await f.path.initialize();
  f.setCurrentPolicy({ nftables: [{ foreign: true }] });
  await assert.rejects(f.path.remove(), /Foreign nft/);
  assert.equal(f.guarded, true); assert.ok(!f.events.includes('life-remove'));
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
