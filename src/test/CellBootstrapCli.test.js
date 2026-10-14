'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { configFromEnvironment, runCellBootstrapCli } = require('../lib/CellBootstrapCli');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { generateOfficialProfile } = require('../lib/Awg3Config');

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
});

test('Cell CLI starts registered service with bounded readiness status', async () => {
  let printed = '';
  const service = { close: async () => {}, running: new Promise(() => {}) };
  assert.equal(await runCellBootstrapCli({ args: ['serve'], env: environment(),
    output: { write: value => { printed += value; } },
    openHost: async () => ({}), startService: async () => service }), service);
  assert.equal(printed, '{"status":"serving","transport":"AWG"}\n');
});
