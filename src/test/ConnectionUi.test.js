'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const setup = (load) => {
  const timers = new Map();
  let id = 0;
  const context = { window: {}, AbortController,
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: (key) => timers.delete(key) };
  for (const file of ['diagnostics.js', 'connection.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../www/js', file), 'utf8'), context);
  }
  const states = [], sessions = [];
  const controller = context.window.awgConnection({ load,
    createPoller: context.window.awgDiagnostics.createPoller,
    onState: s => states.push(s), onSession: s => sessions.push(s) });
  return { controller, timers, states, sessions };
};

test('startup, unavailable server, retry and recovery only probe the session', async () => {
  let failed = true;
  const f = setup(async () => { if (failed) throw new Error('network'); return { authenticated: true }; });
  await f.controller.start();
  assert.deepEqual(f.states, ['connecting', 'unavailable']);
  failed = false;
  await f.controller.retry();
  assert.equal(f.states.at(-1), 'ready');
  assert.equal(f.sessions.length, 1);
  await f.controller.retry();
  assert.equal(f.sessions.length, 1, 'healthy polling must not reload client cards');
  failed = true;
  await f.controller.retry();
  failed = false;
  await f.controller.retry();
  assert.equal(f.sessions.length, 2, 'recovery refreshes the authenticated view');
  f.controller.stop();
  assert.equal(f.timers.size, 0);
});

test('eight-second deadline works even when fetch ignores abort; late answers are ignored', async () => {
  let resolve, signal;
  const f = setup(s => { signal = s; return new Promise(r => { resolve = r; }); });
  const pending = f.controller.start();
  await new Promise(setImmediate);
  [...f.timers.values()].find(t => t.ms === 8000).fn();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(f.states.at(-1), 'unavailable');
  resolve({ authenticated: true });
  await new Promise(setImmediate);
  assert.equal(f.sessions.length, 0);
  f.controller.stop();
});

test('expired authentication and malformed session responses are handled', async () => {
  let session = { authenticated: true };
  const f = setup(async () => session);
  await f.controller.start();
  session = { authenticated: false };
  await f.controller.retry();
  assert.equal(f.sessions.at(-1).authenticated, false);
  session = {};
  await f.controller.retry();
  assert.equal(f.states.at(-1), 'unavailable');
  f.controller.stop();
});
