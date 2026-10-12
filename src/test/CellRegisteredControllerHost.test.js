'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openRegisteredControllerHost } = require('../lib/CellRegisteredControllerHost');

test('controller opens revision runtime and mutates topology only under one lock', async () => {
  const stateDirectory = path.resolve('controller-state'), events = [];
  const runtime = { join: async options => { events.push(['join', options]); return 'joined'; },
    recoverBoot: async options => { events.push(['boot', options]); return 'booted'; } };
  const host = await openRegisteredControllerHost({ stateDirectory,
    openRuntime: async options => { events.push(['open', options]); return runtime; },
    withLock: async ({ lockPath, work }) => {
      assert.equal(lockPath, path.join(stateDirectory, 'install.lock'));
      events.push(['lock-enter']);
      try { return await work(); } finally { events.push(['lock-exit']); }
    } });
  assert.equal(await host.join({ cell: 2 }), 'joined');
  assert.equal(await host.recoverBoot({ reboot: true }), 'booted');
  assert.deepEqual(events.map(item => item[0]), [
    'lock-enter', 'open', 'lock-exit',
    'lock-enter', 'join', 'lock-exit',
    'lock-enter', 'boot', 'lock-exit']);
  assert.equal(events[1][1].stateDirectory, path.join(stateDirectory, 'permanent'));
});

test('controller host rejects ambiguous state directory', async () => {
  await assert.rejects(openRegisteredControllerHost({ stateDirectory: 'relative' }),
    /Registered controller host dependencies/);
});
