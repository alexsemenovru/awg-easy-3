'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { configFromEnvironment, runCellBootstrapCli } = require('../lib/CellBootstrapCli');

const environment = () => ({ AWG_CELL_STATE_DIR: path.resolve('cell-state'),
  AWG_CELL_BOOTSTRAP_INTERFACE: 'awgjoin0', AWG_CELL_CONTROL_INTERFACE: 'awgctl0',
  AWG_CELL_USER_INTERFACE: 'awg0', AWG_CELL_USER_PORT: '51820' });

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
  await runCellBootstrapCli({ args: ['begin'], env: environment(),
    input: Readable.from(['sensitive-one-time-code\n']), output: { write: value => { printed += value; } },
    openHost: async () => ({ initial: { begin: async code => { suppliedCode = code; return { ready: true }; } } }),
  });
  assert.equal(suppliedCode, 'sensitive-one-time-code');
  assert.equal(printed, '{"status":"bootstrap-ready"}\n');
  assert.ok(!printed.includes(suppliedCode));
});

test('Cell CLI supports bounded recovery and registration without stdin', async () => {
  const calls = [];
  let printed = '';
  const openHost = async () => ({ initial: { resume: async () => { calls.push('resume'); return { ready: true }; } },
    registration: { register: async () => { calls.push('register'); return { status: 'registered' }; } } });
  for (const command of ['resume', 'register']) {
    await runCellBootstrapCli({ args: [command], env: environment(), input: null,
      output: { write: value => { printed += value; } }, openHost });
  }
  assert.deepEqual(calls, ['resume', 'register']);
  assert.equal(printed, '{"status":"bootstrap-ready"}\n{"status":"registered"}\n');
});

test('Cell CLI rejects oversized invitations before opening host state', async () => {
  let opened = false;
  await assert.rejects(runCellBootstrapCli({ args: ['begin'], env: environment(),
    input: Readable.from(['x'.repeat(8195)]), output: { write() {} },
    openHost: async () => { opened = true; } }), /too large/);
  assert.equal(opened, false);
});
