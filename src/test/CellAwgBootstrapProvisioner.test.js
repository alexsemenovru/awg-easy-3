'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { prepareBootstrapDevice } = require('../lib/CellAwgBootstrapDevice');
const { CellAwgBootstrapProvisioner } = require('../lib/CellAwgBootstrapProvisioner');

async function fixture() {
  const spec = await prepareBootstrapDevice({ interfaceName: 'awg-enroll', listenPort: 51824,
    controllerAddress: '10.90.0.1', privateKey: crypto.randomBytes(32).toString('base64'),
    profile: generateOfficialProfile(), runner: async (program) => ({ stdout: program === 'ip'
      ? JSON.stringify([{ ifname: 'awg3' }]) : '' }) });
  let life = { version: 1, phase: 'empty', spec: null, blankHash: null };
  let awgState = { committed: null, pending: null };
  let nftState = { committed: null, pending: null }, nftCurrent = null;
  let guarded = false;
  const events = [], invitations = [];
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
    create: async value => {
      assert.equal(guarded, true);
      life = { version: 1, phase: 'ready', spec: value, blankHash: null };
      events.push('life-create');
    },
    recover: async () => {
      assert.equal(guarded, true); life.phase = 'ready'; events.push('life-recover');
    },
    verify: async value => {
      assert.deepEqual(value, spec); return { up: true };
    },
  };
  const awg = {
    load: async () => structuredClone(awgState),
    initialize: async value => {
      assert.equal(guarded, true); awgState.committed = value; events.push('awg-init');
    },
    recover: async () => { assert.equal(guarded, true); events.push('awg-recover'); },
    inspect: async () => ({ manifest: awgState.committed, up: true }),
  };
  const firewall = { table: 'awg_easy_3_bootstrap',
    load: async () => structuredClone(nftState),
    recover: async () => { assert.equal(guarded, true); events.push('nft-recover'); },
    apply: async value => {
      assert.equal(guarded, true); nftState.committed = value; nftCurrent = value; events.push('nft-apply');
    },
    current: async () => structuredClone(nftCurrent),
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  };
  const provisioner = new CellAwgBootstrapProvisioner({ store: { read: async () => ({ invitations }) },
    lifecycle, awg, firewall, guard, interfaceName: 'awg-enroll',
    controllerAddress: '10.90.0.1', registrationPort: 51822 });
  return { spec, provisioner, events, invitations, guard, awgState,
    setLife: value => { life = value; }, get guarded() { return guarded; } };
}

test('empty dedicated interface and deny policy are ready before guard release', async () => {
  const f = await fixture();
  assert.deepEqual(await f.provisioner.initialize(f.spec), { ready: true });
  assert.deepEqual(f.events.filter(x => ['guard-protect', 'life-create', 'awg-init',
    'nft-apply', 'guard-release'].includes(x)),
  ['guard-protect', 'life-create', 'awg-init', 'nft-apply', 'guard-release']);
  assert.equal(f.guarded, false);
});

test('interrupted creation resumes only its journaled interface identity', async () => {
  const f = await fixture();
  f.setLife({ version: 1, phase: 'creating', spec: f.spec, blankHash: null });
  await f.provisioner.recover();
  assert.equal(f.events.includes('life-create'), false);
  assert.equal(f.events.includes('life-recover'), true);
  assert.equal(f.guarded, false);
  await assert.rejects(f.provisioner.initialize(f.spec), /requires recovery/);
});

test('live invitation or changed child ownership prevents initial provisioning', async () => {
  const f = await fixture();
  f.invitations.push({ phase: 'ready' });
  await assert.rejects(f.provisioner.initialize(f.spec), /live invitations/);
  assert.equal(f.events.length, 0);
  f.invitations.length = 0;
  f.setLife({ version: 1, phase: 'ready', spec: f.spec, blankHash: null });
  f.awgState.committed = { ...f.spec.owner, ownerTag: 'foreign' };
  await assert.rejects(f.provisioner.recover(), /differs from initial identity/);
  assert.equal(f.guarded, true);
  assert.equal(f.events.includes('guard-release'), false);
});

test('recovery refuses a journaled bootstrap device with a different address', async () => {
  const f = await fixture();
  f.setLife({ version: 1, phase: 'ready', spec: {
    ...f.spec, addresses: ['10.90.0.9/32'],
  }, blankHash: null });
  await assert.rejects(f.provisioner.recover(), /own address and no peers/);
  assert.equal(f.guarded, true);
  assert.equal(f.events.includes('awg-init'), false);
  assert.equal(f.events.includes('guard-release'), false);
});
