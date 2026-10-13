'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { openCellInitialInstallation, prepareCellInitialInstallation } = require('../lib/CellInitialInstallation');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const key = char => Buffer.alloc(32, char).toString('base64');
const token = char => Buffer.alloc(32, char).toString('base64url');

async function invitation() {
  const generated = await createAwgBootstrapInvitation({
    controllerKey: token(2), endpointHost: '203.0.113.2', endpointPort: 51820,
    registrationPort: 51822, controllerAddress: '10.88.0.1',
    cellAddress: '10.88.0.2', serverPublicKey: key(3),
    profile: generateOfficialProfile(),
    keyManager: { generatePeerKeys: async () => ({ privateKey: key(4),
      publicKey: key(5), presharedKey: key(6) }) }, now: Date.now(),
  });
  return generated.code;
}

function fixture(code, { preflightError, identityError } = {}) {
  const calls = [];
  let connection = null;
  let phase = 'empty';
  let permanent = null;
  let identityExists = false;
  const identityStore = {
    load: async role => { assert.equal(role, 'cell'); calls.push('load-identity');
      if (identityError) throw identityError;
      if (!identityExists) throw Object.assign(new Error('Identity missing'), { code: 'ENOENT' });
      return { role: 'cell' }; },
    create: async role => { assert.equal(role, 'cell'); calls.push('create-identity');
      identityExists = true; return { role: 'cell' }; },
  };
  const connectionStore = { read: async () => connection,
    begin: async value => { calls.push('begin');
      connection = { status: 'pending', invitation: JSON.parse(Buffer.from(value, 'base64url')) }; } };
  const lifecycle = { load: async () => ({ phase }) };
  const permanentPlanStore = { read: async () => permanent };
  const provisioner = {
    initialize: async value => { calls.push('initialize'); assert.equal(value, code);
      phase = 'ready'; return { ready: true }; },
    recover: async () => { calls.push('recover'); return { ready: true }; },
  };
  const resources = { interfaceNames: ['awg-cell-bootstrap', 'awg-cell-control'],
    udpPorts: [51820], nftTables: ['awg_easy_3_bootstrap', 'awg_easy_3_control'] };
  const host = openCellInitialInstallation({ stateDirectory: path.resolve('cell-state'),
    connectionStore, lifecycle, permanentPlanStore, provisioner, identityStore, resources,
    preflight: async value => { assert.strictEqual(value, resources); calls.push('preflight');
      if (preflightError) throw preflightError; },
    withLock: async ({ lockPath, work }) => { assert.equal(path.basename(lockPath), 'install.lock');
      calls.push('lock'); return work(); } });
  return { host, calls, setConnection: value => { connection = value; },
    setPhase: value => { phase = value; }, setPermanent: value => { permanent = value; },
    setIdentity: value => { identityExists = value; } };
}

test('new Cell verifies resources under the installation lock before persisting or creating a device', async () => {
  const code = await invitation();
  const f = fixture(code);
  assert.deepEqual(await f.host.begin(code), { ready: true });
  assert.deepEqual(f.calls, ['lock', 'preflight', 'load-identity', 'create-identity', 'begin', 'initialize']);
  await assert.rejects(f.host.begin(code), /Existing Cell state/);
  assert.deepEqual(f.calls.slice(6), ['lock']);
});

test('interrupted connection reservation resumes with preflight; owned device recovery skips it', async () => {
  const code = await invitation();
  const f = fixture(code);
  const pending = { status: 'pending', invitation: JSON.parse(Buffer.from(code, 'base64url')) };
  f.setConnection(pending);
  assert.deepEqual(await f.host.resume(), { ready: true });
  assert.deepEqual(f.calls, ['lock', 'preflight', 'initialize']);
  f.calls.length = 0;
  f.setPhase('creating');
  assert.deepEqual(await f.host.resume(), { ready: true });
  assert.deepEqual(f.calls, ['lock', 'recover']);
});

test('preflight failure never reserves an invitation or creates a bootstrap device', async () => {
  const code = await invitation();
  const f = fixture(code, { preflightError: new Error('UDP port occupied') });
  await assert.rejects(f.host.begin(code), /UDP port occupied/);
  assert.deepEqual(f.calls, ['lock', 'preflight']);
  await assert.rejects(f.host.resume(), /Pending Cell bootstrap/);
});

test('first installation reuses an existing Cell identity and never replaces a corrupt one', async () => {
  const code = await invitation();
  const f = fixture(code);
  f.setIdentity(true);
  await f.host.begin(code);
  assert.deepEqual(f.calls, ['lock', 'preflight', 'load-identity', 'begin', 'initialize']);
  const corrupt = fixture(code, { identityError: new Error('Invalid control identity') });
  await assert.rejects(corrupt.host.begin(code), /Invalid control identity/);
  assert.deepEqual(corrupt.calls, ['lock', 'preflight', 'load-identity']);
});

test('initial Cell refuses conflicts and invalid recovery without touching host resources', async () => {
  const code = await invitation();
  const f = fixture(code);
  await assert.rejects(f.host.begin('bad-code'), /Invalid or unavailable AWG cell invitation/);
  assert.deepEqual(f.calls, ['lock']);
  f.calls.length = 0;
  f.setPermanent({ version: 1 });
  await assert.rejects(f.host.begin(code), /Existing Cell state/);
  assert.deepEqual(f.calls, ['lock']);
  f.calls.length = 0;
  await assert.rejects(f.host.resume(), /Pending Cell bootstrap/);
  assert.deepEqual(f.calls, ['lock']);
  f.calls.length = 0;
  f.setConnection({ status: 'pending', invitation: JSON.parse(Buffer.from(code, 'base64url')) });
  await assert.rejects(f.host.resume(), /Permanent Cell plan exists/);
  assert.deepEqual(f.calls, ['lock']);
});

test('product entry point validates dependencies before preparing its private state root', async () => {
  const prepared = [];
  await assert.rejects(prepareCellInitialInstallation({ stateDirectory: 'relative' },
    async directory => prepared.push(directory)), /dependencies required/);
  assert.deepEqual(prepared, []);
  // The preparation helper may be injected only for this model test; on Linux
  // the default checks ownership and permissions before any lock is opened.
  const stateDirectory = path.resolve('cell-state');
  const source = {
    stateDirectory, connectionStore: { read: async () => null, begin: async () => {} },
    lifecycle: { load: async () => ({ phase: 'empty' }) },
    permanentPlanStore: { read: async () => null },
    provisioner: { initialize: async () => {}, recover: async () => {} },
    identityStore: { load: async () => ({}), create: async () => ({}) },
    resources: { interfaceNames: ['awgjoin0'], udpPorts: [51820], nftTables: ['awg_easy_3_bootstrap'] },
    withLock: async ({ work }) => work(), preflight: async () => {},
  };
  const host = await prepareCellInitialInstallation(source, async directory => prepared.push(directory));
  assert.equal(typeof host.begin, 'function');
  assert.equal(typeof host.resume, 'function');
  assert.deepEqual(prepared, [stateDirectory]);
});
