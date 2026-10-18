'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { Readable } = require('node:stream');
const test = require('node:test');
const { configFromEnvironment, runCellBootstrapCli } = require('../lib/CellBootstrapCli');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { readCellStatus } = require('../lib/CellStatus');

const environment = () => ({ AWG_CELL_STATE_DIR: path.resolve('cell-state'),
  AWG_CELL_RUNTIME_DIR: path.resolve('cell-runtime'),
  AWG_CELL_BOOTSTRAP_INTERFACE: 'awgjoin0', AWG_CELL_CONTROL_INTERFACE: 'awgctl0',
  AWG_CELL_USER_INTERFACE: 'awg0', AWG_CELL_USER_PORT: '51820' });
const key = byte => Buffer.alloc(32, byte).toString('base64');
const token = byte => Buffer.alloc(32, byte).toString('base64url');
async function invitation() {
  return (await createAwgBootstrapInvitation({ controllerKey: token(2),
    endpointHost: '203.0.113.2', endpointPort: 51820,
    registrationPort: 51822, controllerAddress: '10.88.0.1',
    cellAddress: '10.88.0.2', serverPublicKey: key(3),
    profile: generateOfficialProfile(), now: Date.now(),
    keyManager: { generatePeerKeys: async () => ({ privateKey: key(4),
      publicKey: key(5), presharedKey: key(6) }) } })).code;
}

test('Cell CLI reserves all intended interfaces, port and nft tables', () => {
  const config = configFromEnvironment(environment());
  assert.deepEqual(config.resources.interfaceNames, ['awgjoin0', 'awgctl0', 'awg0']);
  assert.deepEqual(config.resources.udpPorts, [51820]);
  assert.ok(config.resources.nftTables.includes('awg_easy_3_bootstrap_guard'));
  assert.ok(config.resources.nftTables.includes('awg_easy_3_cell_guard'));
  assert.throws(() => configFromEnvironment({ ...environment(), AWG_CELL_USER_PORT: '0' }));
  assert.throws(() => configFromEnvironment({ ...environment(), AWG_CELL_CONTROL_INTERFACE: 'awg0' }));
});

test('Cell CLI reads invitation only from stdin and prints no secret', async () => {
  let suppliedCode;
  let printed = '';
  const code = await invitation();
  await runCellBootstrapCli({ args: ['begin'], env: environment(),
    input: Readable.from([`${code}\n`]), output: { write: value => { printed += value; } },
    openHost: async () => ({ initial: { begin: async code => { suppliedCode = code; return { ready: true }; } } }),
  });
  assert.equal(suppliedCode, code);
  assert.equal(printed, '{"status":"bootstrap-ready"}\n');
  assert.ok(!printed.includes(suppliedCode));
});

test('Cell CLI rejects malformed invitation before creating host state', async () => {
  let opened = false;
  await assert.rejects(runCellBootstrapCli({ args: ['begin'], env: environment(),
    input: Readable.from(['not-an-invitation']), output: { write() {} },
    openHost: async () => { opened = true; } }), /Invalid or unavailable AWG cell invitation/);
  assert.equal(opened, false);
});

test('Cell CLI requires a status sink before any host operation', async () => {
  let opened = false;
  await assert.rejects(runCellBootstrapCli({ args: ['resume'], env: environment(),
    output: null, openHost: async () => { opened = true; } }), /status output/);
  assert.equal(opened, false);
});

test('Cell CLI supports bounded recovery, registration and join without stdin', async () => {
  const calls = [];
  let printed = '';
  const openHost = async () => ({ initial: { resume: async () => { calls.push('resume'); return { ready: true }; } },
    registration: { register: async () => { calls.push('register'); return { status: 'registered' }; } },
    permanentJoin: { join: async () => { calls.push('join');
      return { status: 'waiting-for-permanent-path' }; } } });
  for (const command of ['resume', 'register', 'join']) {
    await runCellBootstrapCli({ args: [command], env: environment(), input: null,
      output: { write: value => { printed += value; } }, openHost });
  }
  assert.deepEqual(calls, ['resume', 'register', 'join']);
  assert.equal(printed, '{"status":"bootstrap-ready"}\n{"status":"registered"}\n'
    + '{"status":"waiting-for-permanent-path"}\n');
});

test('Cell CLI rejects oversized invitations before opening host state', async () => {
  let opened = false;
  await assert.rejects(runCellBootstrapCli({ args: ['begin'], env: environment(),
    input: Readable.from(['x'.repeat(8195)]), output: { write() {} },
    openHost: async () => { opened = true; } }), /too large/);
  assert.equal(opened, false);
});

test('Cell CLI configures a registered user tunnel without leaking key material', async () => {
  const supplied = { version: 1, server: { privateKey: 'secret' } };
  let stored;
  let printed = '';
  await runCellBootstrapCli({ args: ['configure-user'], env: environment(),
    input: Readable.from([JSON.stringify(supplied)]),
    output: { write: value => { printed += value; } },
    openHost: async () => ({ connectionStore: { read: async () => ({ status: 'registered' }) } }),
    newUserStore: () => ({ create: async value => { stored = value; } }) });
  assert.deepEqual(stored, supplied);
  assert.equal(printed, '{"status":"user-configured"}\n');
  await assert.rejects(runCellBootstrapCli({ args: ['configure-user'], env: environment(),
    input: Readable.from([JSON.stringify(supplied)]), output: { write() {} },
    openHost: async () => ({ connectionStore: { read: async () => null } }),
    newUserStore: () => { throw new Error('must not create store'); },
  }), /Registered Cell required/);
  await assert.rejects(runCellBootstrapCli({ args: ['configure-user'], env: environment(),
    input: Readable.from([JSON.stringify(supplied)]), output: { write() {} },
    openHost: async () => ({ connectionStore: { read: async () => ({ status: 'registered',
      permanent: { privateKey: 'secret' } }) } }),
    newUserStore: () => { throw new Error('must not save reused key'); },
  }), /must be distinct/);
});

test('Cell CLI starts registered service with bounded readiness status', async () => {
  let printed = '';
  const service = { close: async () => {}, running: new Promise(() => {}) };
  assert.equal(await runCellBootstrapCli({ args: ['serve'], env: environment(),
    output: { write: value => { printed += value; } },
    openHost: async () => ({ connectionStore: { read: async () => ({ status: 'registered' }) },
      permanentPlanStore: { read: async () => ({ version: 1 }) },
      bootstrap: { lifecycle: { load: async () => ({ phase: 'empty' }) } } }),
    startService: async () => service }), service);
  assert.equal(printed, '{"status":"serving","transport":"AWG"}\n');
});

test('Cell serve completes pending registration and permanent join before user service', async () => {
  const order = [];
  let state = { status: 'pending' };
  const host = {
    connectionStore: { read: async () => state },
    initial: { resume: async () => { order.push('resume'); return { ready: true }; } },
    registration: { register: async () => { order.push('register');
      state = { status: 'registered' }; return { status: 'registered' }; } },
    permanentPlanStore: { read: async () => null },
    bootstrap: { lifecycle: { load: async () => ({ phase: 'ready' }) } },
    permanentJoin: { join: async () => { order.push('join'); return { status: 'ready' }; } },
  };
  const service = { close: async () => {}, running: new Promise(() => {}) };
  await runCellBootstrapCli({ args: ['serve'], env: environment(), output: { write() {} },
    openHost: async () => host, startService: async () => { order.push('serve'); return service; } });
  assert.deepEqual(order, ['resume', 'register', 'join', 'serve']);
});

test('Cell serve prepares the local user tunnel only after verified join', async () => {
  const order = [];
  const host = { connectionStore: { read: async () => ({ status: 'registered' }) },
    permanentPlanStore: { read: async () => null },
    bootstrap: { lifecycle: { load: async () => ({ phase: 'ready' }) } },
    permanentJoin: { join: async () => { order.push('join'); return { status: 'ready' }; } } };
  await runCellBootstrapCli({ args: ['serve'], env: { ...environment(), AWG_CELL_WAN_INTERFACE: 'eth0' },
    output: { write() {} }, openHost: async () => host,
    ensureUser: async ({ wanInterface }) => { assert.equal(wanInterface, 'eth0'); order.push('user'); },
    startService: async () => { order.push('serve'); return { close() {} }; } });
  assert.deepEqual(order, ['join', 'user', 'serve']);
});

test('Cell serve consumes a private first-run invitation without exposing it', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-first-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'invitation');
  const code = await invitation();
  await fs.writeFile(file, code, { mode: 0o600 });
  const steps = [];
  let state = null;
  let printed = '';
  const host = {
    connectionStore: { read: async () => state },
    initial: { begin: async supplied => { assert.equal(supplied, code);
      steps.push('begin'); state = { status: 'pending' }; return { ready: true }; },
    resume: async () => { throw new Error('must not resume a live first boot'); } },
    registration: { register: async () => { steps.push('register'); state = { status: 'registered' };
      return { status: 'registered' }; } },
    permanentPlanStore: { read: async () => null },
    bootstrap: { lifecycle: { load: async () => ({ phase: 'ready' }) } },
    permanentJoin: { join: async () => { steps.push('join'); return { status: 'ready' }; } },
  };
  await runCellBootstrapCli({ args: ['serve'], env: { ...environment(), AWG_CELL_STATE_DIR: directory,
    AWG_CELL_INVITATION_FILE: file }, output: { write: value => { printed += value; } },
  openHost: async () => host, startService: async () => { steps.push('serve'); return { close() {} }; } });
  assert.deepEqual(steps, ['begin', 'register', 'join', 'serve']);
  assert.equal(printed.includes(code), false);
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
});

test('Cell serve does not open user traffic without invitation or verified permanent path', async () => {
  let started = false;
  const base = {
    permanentPlanStore: { read: async () => null },
    bootstrap: { lifecycle: { load: async () => ({ phase: 'ready' }) } },
    permanentJoin: { join: async () => ({ status: 'waiting-for-permanent-path' }) },
  };
  for (const state of [null, { status: 'registered' }]) {
    await assert.rejects(runCellBootstrapCli({ args: ['serve'], env: environment(),
      output: { write() {} }, openHost: async () => ({ ...base,
        connectionStore: { read: async () => state } }),
      startService: async () => { started = true; } }),
    state ? /not ready/ : /invitation required/);
  }
  assert.equal(started, false);
});

test('Cell CLI one-shot sync reports only status and revision', async () => {
  let printed = '';
  await runCellBootstrapCli({ args: ['sync'], env: environment(),
    output: { write: value => { printed += value; } },
    openHost: async () => ({}),
    syncOnce: async () => ({ status: 'applied', revision: 7,
      privateKey: 'must-not-be-printed' }) });
  assert.equal(printed, '{"status":"applied","revision":7}\n');
});

test('Cell status is read-only, reports absence and never opens installation host', async () => {
  const config = configFromEnvironment({ ...environment(),
    AWG_CELL_STATE_DIR: path.resolve('missing-cell-state-for-status-test') });
  assert.deepEqual(await readCellStatus(config), { registration: 'absent',
    permanentPlan: false, userConfigured: false,
    receivedRevision: null, appliedRevision: null });
  let printed = '';
  await runCellBootstrapCli({ args: ['status'], env: environment(),
    output: { write: value => { printed += value; } },
    openHost: async () => { throw new Error('status must not open host'); },
    statusReader: async () => ({ registration: 'registered', permanentPlan: true,
      userConfigured: true, receivedRevision: 5, appliedRevision: 4,
      privateKey: 'must-not-be-printed' }) });
  assert.deepEqual(JSON.parse(printed), { registration: 'registered',
    permanentPlan: true, userConfigured: true,
    receivedRevision: 5, appliedRevision: 4 });
  assert.equal(printed.includes('must-not-be-printed'), false);
});
