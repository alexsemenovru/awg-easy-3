'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { identity } = require('../lib/CellRegistration');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { prepareBootstrapCellDevice } = require('../lib/CellAwgBootstrapCellDevice');
const { CellAwgBootstrapCellProvisioner } = require('../lib/CellAwgBootstrapCellProvisioner');

const key = () => crypto.randomBytes(32).toString('base64');
async function fixture() {
  const { code } = await createAwgBootstrapInvitation({
    controllerKey: identity().publicKey, endpointHost: 'example.test',
    endpointPort: 51824, registrationPort: 51822,
    controllerAddress: '10.90.0.1', cellAddress: '10.90.0.2', serverPublicKey: key(),
    profile: generateOfficialProfile(), keyManager: { generatePeerKeys: async () => ({
      privateKey: key(), publicKey: key(), presharedKey: key(),
    }) }, now: 1000,
  });
  const invitation = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
  const prepare = input => prepareBootstrapCellDevice({ ...input, now: 1001,
    resolve: async () => [{ address: '198.51.100.7' }] });
  const prepared = await prepare({ code, interfaceName: 'awg-enroll' });
  let connection = { status: 'pending', invitation };
  let life = { version: 1, phase: 'empty', spec: null, blankHash: null };
  let awgState = { committed: null, pending: null };
  let nftState = { committed: null, pending: null }, nftCurrent = null;
  let routeState = { committed: [], pending: null }, guarded = false;
  const events = [];
  const guard = { table: 'awg_easy_3_bootstrap_guard',
    load: async () => ({ interfaces: guarded ? ['awg-enroll'] : [], pending: null }),
    recover: async () => { events.push('guard-recover'); },
    protect: async () => { guarded = true; events.push('guard-protect'); },
    release: async check => {
      if (!await check()) throw new Error('Readback failed');
      guarded = false; events.push('guard-release');
    },
  };
  const lifecycle = {
    load: async () => structuredClone(life),
    create: async spec => {
      assert.equal(guarded, true);
      life = { version: 1, phase: 'ready', spec, blankHash: null };
      events.push('life-create');
    },
    recover: async () => { assert.equal(guarded, true); life.phase = 'ready'; events.push('life-recover'); },
    verify: async spec => {
      assert.equal(spec.owner.config, prepared.spec.owner.config);
      assert.deepEqual(spec.addresses, prepared.spec.addresses);
      return { up: true };
    },
  };
  const awg = {
    load: async () => structuredClone(awgState),
    initialize: async owner => {
      assert.equal(guarded, true); awgState.committed = owner; events.push('awg-init');
    },
    recover: async () => { assert.equal(guarded, true); events.push('awg-recover'); },
    inspect: async () => ({ manifest: awgState.committed, up: true }),
  };
  const firewall = { table: 'awg_easy_3_bootstrap',
    load: async () => structuredClone(nftState),
    recover: async () => { assert.equal(guarded, true); events.push('nft-recover'); },
    apply: async value => {
      assert.equal(guarded, true); nftState.committed = value; nftCurrent = value;
      events.push('nft-apply');
    },
    current: async () => structuredClone(nftCurrent),
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  };
  const routes = {
    load: async () => structuredClone(routeState),
    recover: async () => { assert.equal(guarded, true); events.push('route-recover'); },
    apply: async commands => {
      assert.equal(guarded, true); routeState.committed = commands; events.push('route-apply');
    },
    inventory: async () => ({ routes4: routeState.committed.map(cmd => ({
      dst: cmd.args[3], table: 254, dev: 'awg-enroll', protocol: 186,
      metric: 0, scope: 'link',
    })), routes6: [], rules4: [], rules6: [] }),
  };
  const provisioner = new CellAwgBootstrapCellProvisioner({ connection: { read: async () => connection },
    lifecycle, awg, firewall, routes, guard, interfaceName: 'awg-enroll', prepare,
    now: () => 1001 });
  return { code, prepared, provisioner, events, get guarded() { return guarded; },
    setLife: value => { life = value; }, setConnection: value => { connection = value; },
    setRouteState: value => { routeState = value; } };
}

test('cell creates temporary AWG and exact route under guard before opening registration', async () => {
  const f = await fixture();
  assert.deepEqual(await f.provisioner.initialize(f.code), { ready: true });
  assert.deepEqual(f.events.filter(x => ['life-create', 'awg-init', 'route-apply',
    'nft-apply', 'guard-release'].includes(x)),
  ['life-create', 'awg-init', 'route-apply', 'nft-apply', 'guard-release']);
  assert.equal(f.guarded, false);
});

test('cell recovers journaled DNS endpoint without resolving it again', async () => {
  const f = await fixture();
  f.setLife({ version: 1, phase: 'creating', spec: f.prepared.spec, blankHash: null });
  f.provisioner.prepare = async () => { throw new Error('DNS must not run in recovery'); };
  await f.provisioner.recover();
  assert.equal(f.events.includes('life-create'), false);
  assert.equal(f.guarded, false);
});

test('wrong code, missing invitation or conflicting route journal refuse setup', async () => {
  const f = await fixture();
  await assert.rejects(f.provisioner.initialize('wrong'), /differs/);
  assert.equal(f.events.length, 0);
  f.setConnection({ status: 'registered' });
  await assert.rejects(f.provisioner.initialize(f.code), /Pending/);
  f.setConnection({ status: 'pending', invitation: JSON.parse(Buffer.from(f.code, 'base64url')) });
  f.setRouteState({ committed: [{ file: 'ip', args: ['-4', 'route', 'add',
    '10.90.0.3/32', 'table', 'main', 'proto', '186', 'dev', 'awg-enroll'] }], pending: null });
  await assert.rejects(f.provisioner.initialize(f.code), /route journal differs/);
  assert.equal(f.guarded, true);
  assert.equal(f.events.includes('guard-release'), false);
});

test('cell retains guard when firewall fails after installing its host route', async () => {
  const f = await fixture();
  f.provisioner.firewall.apply = async () => { throw new Error('nft failure'); };
  await assert.rejects(f.provisioner.initialize(f.code), /nft failure/);
  assert.equal(f.guarded, true);
  assert.equal(f.events.includes('route-apply'), true);
  assert.equal(f.events.includes('guard-release'), false);
});

test('recovery refuses a journaled cell configuration that differs from invitation', async () => {
  const f = await fixture();
  const changed = structuredClone(f.prepared.spec);
  changed.owner.config = changed.owner.config.replace('Endpoint = 198.51.100.7:51824',
    'Endpoint = 198.51.100.7:51825');
  f.setLife({ version: 1, phase: 'creating', spec: changed, blankHash: null });
  await assert.rejects(f.provisioner.recover(), /endpoint differs/);
  assert.equal(f.guarded, true);
  assert.equal(f.events.includes('guard-release'), false);
});

test('expired pending invite cannot create a device and recovery closes an existing one', async () => {
  const f = await fixture();
  f.provisioner.now = () => 901001;
  await assert.rejects(f.provisioner.initialize(f.code), /expired/);
  assert.equal(f.events.length, 0);
  f.setLife({ version: 1, phase: 'ready', spec: f.prepared.spec, blankHash: null });
  await assert.rejects(f.provisioner.recover(), /expired/);
  assert.equal(f.guarded, true);
  assert.equal(f.events.includes('guard-release'), false);
});

test('registered receipt with lingering temporary device stays guarded for retirement', async () => {
  const f = await fixture();
  f.setLife({ version: 1, phase: 'ready', spec: f.prepared.spec, blankHash: null });
  f.setConnection({ status: 'registered' });
  await assert.rejects(f.provisioner.recover(), /Pending/);
  assert.equal(f.guarded, true);
});
