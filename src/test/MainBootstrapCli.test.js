'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { configFromEnvironment, runMainBootstrapCli } = require('../lib/MainBootstrapCli');

const environment = () => ({ AWG_MAIN_CELL_STATE_DIR: path.resolve('main-state'),
  AWG_MAIN_BOOTSTRAP_INTERFACE: 'awgmainb0', AWG_MAIN_CONTROL_INTERFACE: 'awgmainc0',
  AWG_MAIN_BOOTSTRAP_PORT: '53081', AWG_MAIN_CONTROL_PORT: '53084',
  AWG_MAIN_REGISTRATION_PORT: '53082', AWG_MAIN_CONTROL_TCP_PORT: '53083',
  AWG_MAIN_BOOTSTRAP_ADDRESS: '10.90.8.1', AWG_MAIN_CONTROL_ADDRESS: '10.91.8.1',
  AWG_MAIN_ENDPOINT: '203.0.113.1' });

test('Main CLI reserves dedicated interfaces, UDP ports and nft tables', () => {
  const config = configFromEnvironment(environment());
  assert.deepEqual(config.resources.interfaceNames, ['awgmainb0', 'awgmainc0']);
  assert.deepEqual(config.resources.udpPorts, [53081, 53084]);
  assert.ok(config.resources.nftTables.includes('awg_easy_3_control_guard'));
  assert.throws(() => configFromEnvironment({ ...environment(), AWG_MAIN_CONTROL_PORT: '0' }));
  assert.throws(() => configFromEnvironment({ ...environment(),
    AWG_MAIN_CONTROL_INTERFACE: 'awgmainb0' }));
  assert.throws(() => configFromEnvironment({ ...environment(),
    AWG_MAIN_BOOTSTRAP_PORT: '53084' }));
});

test('Main CLI validates arity before opening host and emits only bounded status', async () => {
  let opened = 0;
  const openHost = async () => { opened++; return {
    initialize: async () => ({ ready: true }), resume: async () => ({ ready: true }),
    issue: async () => 'test-code', join: async () => ({ status: 'waiting-for-permanent-path' }),
    listen: async () => ({ close() {} }),
  }; };
  let printed = '';
  const output = { write: value => { printed += value; } };
  await assert.rejects(runMainBootstrapCli({ args: ['issue', '10.90.8.2'],
    env: environment(), output, openHost }), /Usage/);
  assert.equal(opened, 0);
  await runMainBootstrapCli({ args: ['init'], env: environment(), output, openHost });
  await runMainBootstrapCli({ args: ['resume'], env: environment(), output, openHost });
  await runMainBootstrapCli({ args: ['join', 'a'.repeat(32)], env: environment(), output, openHost });
  await runMainBootstrapCli({ args: ['listen'], env: environment(), output, openHost });
  assert.equal(printed, '{"status":"bootstrap-ready"}\n{"status":"bootstrap-ready"}\n'
    + '{"status":"waiting-for-permanent-path"}\n{"listening":true,"transport":"AWG"}\n');
  assert.equal(opened, 4);
});

test('Main CLI gives invitation only on explicit issue operation', async () => {
  let received;
  let printed = '';
  await runMainBootstrapCli({ args: ['issue', '10.90.8.2', '10.91.8.2'],
    env: environment(), output: { write: value => { printed += value; } },
    openHost: async () => ({ issue: async value => { received = value; return 'one-time-code'; } }) });
  assert.deepEqual(received, { cellAddress: '10.90.8.2', permanentCellAddress: '10.91.8.2' });
  assert.equal(printed, 'one-time-code\n');
});
