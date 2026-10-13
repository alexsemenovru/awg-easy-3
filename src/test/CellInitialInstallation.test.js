'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { openCellInitialInstallation } = require('../lib/CellInitialInstallation');
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

function fixture(code, { preflightError } = {}) {
  const calls = [];
  let connection = null;
  let phase = 'empty';
  let permanent = null;
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
    connectionStore, lifecycle, permanentPlanStore, provisioner, resources,
    preflight: async value => { assert.strictEqual(value, resources); calls.push('preflight');
      if (preflightError) throw preflightError; },
    withLock: async ({ lockPath, work }) => { assert.equal(path.basename(lockPath), 'install.lock');
      calls.push('lock'); return work(); } });
  return { host, calls, setConnection: value => { connection = value; },
    setPhase: value => { phase = value; }, setPermanent: value => { permanent = value; } };
}

test('new Cell verifies resources under the installation lock before persisting or creating a device', async () => {
  const code = await invitation();
  const f = fixture(code);
  assert.deepEqual(await f.host.begin(code), { ready: true });
  assert.deepEqual(f.calls, ['lock', 'preflight', 'begin', 'initialize']);
  await assert.rejects(f.host.begin(code), /Existing Cell state/);
  assert.deepEqual(f.calls.slice(4), ['lock']);
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
