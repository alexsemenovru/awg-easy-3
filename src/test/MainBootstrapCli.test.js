'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { configFromEnvironment, runMainBootstrapCli } = require('../lib/MainBootstrapCli');

const environment = () => ({ AWG_MAIN_CELL_STATE_DIR: path.resolve('main-state'),
  AWG_MAIN_BOOTSTRAP_INTERFACE: 'awgmainb0', AWG_MAIN_CONTROL_INTERFACE: 'awgmainc0',
  AWG_MAIN_BOOTSTRAP_PORT: '53081', AWG_MAIN_CONTROL_PORT: '53084',
  AWG_MAIN_REGISTRATION_PORT: '53082', AWG_MAIN_CONTROL_TCP_PORT: '53083',
  AWG_MAIN_BOOTSTRAP_ADDRESS: '10.90.8.1', AWG_MAIN_CONTROL_ADDRESS: '10.91.8.1',
  AWG_MAIN_ENDPOINT: '203.0.113.1', AWG_MAIN_USER_INTERFACE: 'awg0',
  AWG_MAIN_USER_PORT: '51820' });

test('Main CLI reserves dedicated interfaces, UDP ports and nft tables', () => {
  const config = configFromEnvironment(environment());
  assert.deepEqual(config.resources.interfaceNames, ['awgmainb0', 'awgmainc0']);
  assert.deepEqual(config.resources.udpPorts, [53081, 53084]);
  assert.deepEqual(config.resources.userInterfaceNames, ['awg0']);
  assert.deepEqual(config.resources.userUdpPorts, [51820]);
  assert.equal(config.userStateFile, undefined);
  assert.ok(config.resources.nftTables.includes('awg_easy_3_control_guard'));
  assert.throws(() => configFromEnvironment({ ...environment(), AWG_MAIN_CONTROL_PORT: '0' }));
  assert.throws(() => configFromEnvironment({ ...environment(),
    AWG_MAIN_CONTROL_INTERFACE: 'awgmainb0' }));
  assert.throws(() => configFromEnvironment({ ...environment(),
    AWG_MAIN_BOOTSTRAP_PORT: '53084' }));
  assert.throws(() => configFromEnvironment({ ...environment(),
    AWG_MAIN_USER_PORT: '53081' }));
  assert.throws(() => configFromEnvironment({ ...environment(),
    AWG_MAIN_CONTROL_TCP_PORT: '53082' }));
  assert.equal(configFromEnvironment({ ...environment(),
    AWG_MAIN_USER_STATE_FILE: path.resolve('data/state.json') }).userStateFile,
  path.resolve('data/state.json'));
  assert.throws(() => configFromEnvironment({ ...environment(),
    AWG_MAIN_USER_STATE_FILE: 'data/state.json' }));
  assert.throws(() => configFromEnvironment({ ...environment(),
    AWG_MAIN_STATUS_FILE: 'cell-status/cells.json' }));
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

test('Main CLI issues automatic invitation without address arguments', async () => {
  let printed = '';
  await runMainBootstrapCli({ args: ['issue-auto'], env: environment(),
    output: { write: value => { printed += value; } },
    openHost: async () => ({ issueAuto: async () => 'one-time-code' }) });
  assert.equal(printed, 'one-time-code\n');
  await assert.rejects(runMainBootstrapCli({ args: ['issue-auto', 'extra'],
    env: environment(), output: { write() {} }, openHost: async () => ({}) }), /Usage/);
});

test('Main CLI publishes bounded JSON settings and exposes revision status only', async () => {
  const published = [];
  let printed = '';
  const openHost = async () => ({
    publish: async (id, value) => { published.push({ id, value }); return { revision: 3 }; },
    settingsStatus: async () => ({ desiredRevision: 3, confirmedRevision: 2,
      awaitingAck: true }),
    listenControl: async () => ({ close() {} }),
  });
  const output = { write: value => { printed += value; } };
  await runMainBootstrapCli({ args: ['publish', 'a'.repeat(32)], env: environment(),
    input: Readable.from(['{"schema":1,"clients":[]}']), output, openHost });
  await runMainBootstrapCli({ args: ['settings-status', 'a'.repeat(32)],
    env: environment(), output, openHost });
  await runMainBootstrapCli({ args: ['control-listen'], env: environment(), output, openHost });
  assert.deepEqual(published, [{ id: 'a'.repeat(32), value: { schema: 1, clients: [] } }]);
  assert.equal(printed, '{"revision":3}\n'
    + '{"desiredRevision":3,"confirmedRevision":2,"awaitingAck":true}\n'
    + '{"controlListening":true,"transport":"AWG"}\n');
});

test('Main CLI lists Cells without invitation or transport secrets', async () => {
  let printed = '';
  await runMainBootstrapCli({ args: ['cells'], env: environment(),
    output: { write: value => { printed += value; } },
    openHost: async () => ({ cells: async () => [{ id: 'a'.repeat(32),
      status: 'consumed', phase: 'closed', createdAt: 123,
      settings: { desiredRevision: 2, confirmedRevision: 1, awaitingAck: true } }] }) });
  assert.deepEqual(JSON.parse(printed), [{ id: 'a'.repeat(32),
    status: 'consumed', phase: 'closed', createdAt: 123,
    settings: { desiredRevision: 2, confirmedRevision: 1, awaitingAck: true } }]);
  await assert.rejects(runMainBootstrapCli({ args: ['cells', 'extra'],
    env: environment(), output: { write() {} }, openHost: async () => ({}) }), /Usage/);
});

test('Main CLI rejects oversized settings before opening host state', async () => {
  let opened = false;
  await assert.rejects(runMainBootstrapCli({ args: ['publish', 'a'.repeat(32)],
    env: environment(), input: Readable.from(['x'.repeat(2 * 1024 * 1024 + 1)]),
    output: { write() {} }, openHost: async () => { opened = true; } }), /size limit/);
  assert.equal(opened, false);
});

test('Main serve recovers paths before binding and closes listeners only', async () => {
  const order = [];
  let printed = '';
  const host = {
    isPristine: async () => false,
    resume: async () => { order.push('bootstrap'); return { ready: true }; },
    recoverPermanentBoot: async () => { order.push('permanent'); return { configured: true }; },
    listen: async () => { order.push('registration'); return { close: async () => order.push('close-registration') }; },
    listenControl: async () => { order.push('control'); return { close: async () => order.push('close-control') }; },
  };
  const service = await runMainBootstrapCli({ args: ['serve'], env: environment(),
    output: { write: value => { printed += value; } }, openHost: async () => host });
  assert.equal(printed, '{"status":"serving","permanentConfigured":true}\n');
  await service.close();
  assert.deepEqual(order, ['bootstrap', 'permanent', 'registration', 'control',
    'close-control', 'close-registration']);
});

test('Main serve closes registration listener when control binding fails', async () => {
  const order = [];
  await assert.rejects(runMainBootstrapCli({ args: ['serve'], env: environment(),
    output: { write() { throw new Error('must not report ready'); } },
    openHost: async () => ({
      isPristine: async () => false,
      resume: async () => ({ ready: true }),
      recoverPermanentBoot: async () => ({ configured: true }),
      listen: async () => ({ close: async () => order.push('registration-closed') }),
      listenControl: async () => { throw new Error('control unavailable'); },
    }),
  }), /control unavailable/);
  assert.deepEqual(order, ['registration-closed']);
});

test('Main serve publishes bounded Cell status before reporting ready', async () => {
  const order = [];
  let printed = '';
  const service = await runMainBootstrapCli({ args: ['serve'], env: {
    ...environment(), AWG_MAIN_STATUS_FILE: path.resolve('cell-status/cells.json') },
  output: { write: value => { order.push('ready'); printed += value; } },
  openHost: async () => ({
    isPristine: async () => false,
    resume: async () => ({ ready: true }),
    recoverPermanentBoot: async () => ({ configured: false }),
    listen: async () => ({ close: async () => order.push('closed') }),
    cells: async () => [{ id: 'a'.repeat(32), status: 'pending', phase: 'ready', createdAt: 1 }],
    entryDescriptors: async () => [],
  }),
  newEntrySnapshot: () => ({ write: async entries => { order.push('entry-snapshot');
    assert.deepEqual(entries, []); } }),
  newStatusSnapshot: () => ({ write: async records => { order.push('snapshot');
    assert.equal(records.length, 1); } }) });
  assert.deepEqual(order, ['entry-snapshot', 'snapshot', 'ready']);
  assert.match(printed, /"status":"serving"/);
  await service.close();
  assert.deepEqual(order, ['entry-snapshot', 'snapshot', 'ready', 'closed']);
});

test('Main serve initializes only a verified pristine host and never retries failed recovery', async () => {
  const steps = [];
  const openHost = async () => ({
    isPristine: async () => { steps.push('check'); return true; },
    initialize: async () => { steps.push('initialize'); return { ready: true }; },
    resume: async () => { throw new Error('must not resume new installation'); },
    recoverPermanentBoot: async () => ({ configured: false }),
    listen: async () => ({ close: async () => {} }),
  });
  const service = await runMainBootstrapCli({ args: ['serve'], env: environment(),
    output: { write() {} }, openHost });
  assert.deepEqual(steps, ['check', 'initialize']);
  await service.close();

  let initialized = false;
  await assert.rejects(runMainBootstrapCli({ args: ['serve'], env: environment(),
    output: { write() {} }, openHost: async () => ({
      isPristine: async () => false,
      initialize: async () => { initialized = true; },
      resume: async () => { throw new Error('partial state'); },
    }) }), /partial state/);
  assert.equal(initialized, false);
});

test('Main serve reconciles registered Cell automatically and opens control only after recovery', async () => {
  const calls = [];
  let ready = false;
  let controlOpen = false;
  const host = {
    isPristine: async () => false,
    resume: async () => ({ ready: true }),
    recoverPermanentBoot: async () => {
      calls.push('recover');
      if (!ready) throw new Error('Permanent AWG path is not operational after boot recovery');
      return { configured: true };
    },
    listen: async () => { calls.push('registration'); return { close: async () => {} }; },
    listenControl: async () => {
      calls.push('control');
      if (!ready) throw new Error('Permanent Main control path is not operational');
      controlOpen = true; return { close: async () => {} };
    },
    cells: async () => [{ id: 'a'.repeat(32), status: 'consumed', phase: 'ready' }],
    join: async () => { calls.push('join'); ready = true; return { status: 'ready' }; },
    reconcileClientAssignments: async () => ({ skipped: 'no-cell-assignments' }),
  };
  const service = await runMainBootstrapCli({ args: ['serve'], env: environment(),
    output: { write() {} }, openHost: async () => host });
  assert.deepEqual(calls, ['recover', 'registration', 'control']);
  assert.equal(controlOpen, false);
  await service.reconcile();
  assert.equal(controlOpen, true);
  assert.ok(calls.includes('join'));
  await service.close();
});

test('Main serve does not reinterpret corrupt permanent state as a transient disconnect', async () => {
  let listened = false;
  await assert.rejects(runMainBootstrapCli({ args: ['serve'], env: environment(),
    output: { write() {} }, openHost: async () => ({
      isPristine: async () => false, resume: async () => ({ ready: true }),
      recoverPermanentBoot: async () => { throw new Error('Invalid permanent revision journal'); },
      listen: async () => { listened = true; },
    }) }), /Invalid permanent revision journal/);
  assert.equal(listened, false);
});

test('Main serve seeds joined Cell settings during reconciliation', async () => {
  const id = 'b'.repeat(32);
  const seeded = [];
  const host = {
    isPristine: async () => false,
    resume: async () => ({ ready: true }),
    recoverPermanentBoot: async () => ({ configured: false }),
    listen: async () => ({ close: async () => {} }),
    cells: async () => [{ id, status: 'consumed', phase: 'closed', settings: {
      desiredRevision: null, confirmedRevision: null, awaitingAck: false } }],
    ensureInitialSettings: async value => { seeded.push(value); },
    reconcileClientAssignments: async () => ({ skipped: 'no-cell-assignments' }),
  };
  const service = await runMainBootstrapCli({ args: ['serve'], env: environment(),
    output: { write() {} }, openHost: async () => host });
  await service.reconcile();
  await service.close();
  assert.deepEqual(seeded, [id]);
});

test('Main reserves a data offer after both Cell announcements without activating traffic', async () => {
  const id = 'c'.repeat(32), calls = [];
  const host = {
    isPristine: async () => false,
    resume: async () => ({ ready: true }),
    recoverPermanentBoot: async () => ({ configured: false }),
    listen: async () => ({ close: async () => {} }),
    cells: async () => [{ id, status: 'consumed', phase: 'closed',
      settings: { desiredRevision: 1 } }],
    dataPublicKey: async () => 'announced-key',
    userDescriptor: async () => ({ version: 1 }),
    prepareDataOffer: async value => { calls.push(value); return { created: true }; },
    stageDataLink: async value => { calls.push(`stage:${value}`);
      return { ready: true, guarded: true }; },
    reconcileClientAssignments: async () => ({}),
  };
  const service = await runMainBootstrapCli({ args: ['serve'],
    env: { ...environment(), AWG_MAIN_USER_STATE_FILE: path.resolve('data/state.json') },
    output: { write() {} }, openHost: async () => host });
  await service.reconcile(); await service.reconcile(); await service.close();
  assert.deepEqual(calls, [id, `stage:${id}`, id]);
});
