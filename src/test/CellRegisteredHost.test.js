'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openRegisteredCellHost } = require('../lib/CellRegisteredHost');

const options = () => ({ stateDirectory: path.resolve('cell-state'),
  runtimeDirectory: path.resolve('cell-runtime'),
  connectionStore: { read: async () => ({ status: 'registered' }) },
  identityStore: { load: async () => ({}) }, bootstrap: {},
  temporaryInterfaceName: 'awgjoin0', server: { interfaceName: 'awgcell0' } });

test('registered Cell host uses one lock for boot, join and every settings poll', async () => {
  const input = options(), events = [];
  const settings = { adapter: { prepareBoot: async () => {} },
    receiver: { restoreApplied: async () => ({}) } };
  const permanent = { recoverBoot: async value => { events.push(['boot', value]); return 'booted'; },
    join: async value => { events.push(['join', value]); return 'joined'; },
    syncSettings: async value => { events.push(['sync', value]); return 'synced'; } };
  const host = await openRegisteredCellHost({ ...input,
    openSettings: async value => { events.push(['settings-open', value]); return settings; },
    openPermanent: value => { events.push(['permanent-open', value]); return permanent; },
    withLock: async ({ lockPath, work }) => {
      assert.equal(lockPath, path.join(input.stateDirectory, 'install.lock'));
      events.push(['lock-enter']);
      try { return await work(); } finally { events.push(['lock-exit']); }
    } });
  assert.equal(await host.recoverBoot({ test: 1 }), 'booted');
  assert.equal(await host.join({ test: 2 }), 'joined');
  assert.equal(await host.syncSettings(), 'synced');
  let poller;
  poller = host.createPoller({ onStatus: status => {
    if (status.state === 'connected') poller.controller.abort(); } });
  await poller.start();
  assert.equal(events.filter(item => item[0] === 'lock-enter').length, 4);
  assert.equal(events.filter(item => item[0] === 'lock-exit').length, 4);
  assert.deepEqual(events.filter(item => ['boot', 'join', 'sync'].includes(item[0]))
    .map(item => item[0]), ['boot', 'join', 'sync', 'sync']);
  assert.equal(events[0][1].stateDirectory, path.join(input.stateDirectory, 'settings'));
  assert.equal(events[1][1].stateDirectory, path.join(input.stateDirectory, 'permanent'));
  assert.equal(events[1][1].clientRuntime, settings.adapter);
});

test('registered Cell host rejects missing absolute state and identity', async () => {
  await assert.rejects(openRegisteredCellHost({ ...options(), stateDirectory: 'relative' }),
    /Registered Cell host dependencies/);
  await assert.rejects(openRegisteredCellHost({ ...options(), identityStore: null }),
    /Registered Cell host dependencies/);
});
