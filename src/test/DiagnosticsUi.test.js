'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const setup = () => {
  const timers = new Map();
  let nextId = 0;
  const context = {
    window: {}, AbortController,
    setTimeout: (callback, ms) => { timers.set(++nextId, { callback, ms }); return nextId; },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'diagnostics.js'), 'utf8'), context);
  return { ...context.window.awgDiagnostics, timers };
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(setImmediate);

test('diagnostics API forwards cancellation to fetch', async () => {
  const calls = [];
  const context = { window: {}, fetch: async (...args) => {
    calls.push(args);
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => [] };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'api.js'), 'utf8'), context);
  const controller = new AbortController();
  await context.window.awgApi.diagnostics(controller.signal);
  assert.equal(calls[0][0], '/api/v1/diagnostics');
  assert.equal(calls[0][1].signal, controller.signal);
  assert.equal(calls[0][1].credentials, 'same-origin');
});

test('formats bytes/s as bits/s explicitly and never presents a missing sample as zero', () => {
  const { formatRate } = setup();
  for (const bad of [null, undefined, NaN, Infinity]) assert.equal(formatRate(bad), '—');
  assert.equal(formatRate(0), '0 bit/s');
  assert.equal(formatRate(25), '200 bit/s');
  assert.equal(formatRate(200), '1.6 Kbit/s');
  assert.equal(formatRate(125_000), '1.0 Mbit/s');
});

test('polling serializes refreshes and schedules the next one only after completion', async () => {
  const { createPoller, timers } = setup();
  const request = deferred();
  const data = [];
  let loads = 0;
  const poller = createPoller({ load: () => { loads += 1; return request.promise; }, onData: (x) => data.push(x), onError: assert.fail });
  const first = poller.start();
  assert.strictEqual(poller.refresh(), first);
  await flush();
  assert.equal(loads, 1);
  assert.equal([...timers.values()].filter((x) => x.ms === 4000).length, 0);
  request.resolve(['sample']);
  await first;
  assert.deepEqual(data, [['sample']]);
  assert.equal([...timers.values()].filter((x) => x.ms === 4000).length, 1);
  poller.stop();
  assert.equal(timers.size, 0);
});

test('timeout reports unavailable and late responses cannot repaint old speeds', async () => {
  const { createPoller, timers } = setup();
  const request = deferred();
  const data = [];
  const errors = [];
  let signal;
  const poller = createPoller({ load: (s) => { signal = s; return request.promise; }, onData: (x) => data.push(x), onError: (x) => errors.push(x) });
  const first = poller.start();
  await flush();
  [...timers.values()].find((x) => x.ms === 8000).callback();
  await first;
  assert.equal(signal.aborted, true);
  assert.equal(errors.length, 1);
  request.resolve(['old']);
  await flush();
  assert.deepEqual(data, []);
  poller.stop();
});

test('stop/restart ignores previous successful responses and cancels their timers', async () => {
  const { createPoller, timers } = setup();
  const old = deferred();
  let count = 0;
  const data = [];
  const poller = createPoller({ load: () => ++count === 1 ? old.promise : Promise.resolve(['new']), onData: (x) => data.push(x), onError: assert.fail });
  const first = poller.start();
  await flush();
  const second = poller.start();
  old.resolve(['old']);
  await Promise.all([first, second]);
  assert.deepEqual(data, [['new']]);
  assert.equal(timers.size, 1);
  poller.stop();
});

test('HTTP failures report unavailable and polling can recover', async () => {
  const { createPoller } = setup();
  const errors = [];
  const data = [];
  let failing = true;
  const poller = createPoller({ load: async () => {
    if (failing) throw new Error('network failed');
    return ['recovered'];
  }, onData: (x) => data.push(x), onError: (x) => errors.push(x) });
  await poller.start();
  assert.equal(errors.length, 1);
  failing = false;
  await poller.refresh();
  assert.deepEqual(data, [['recovered']]);
  poller.stop();
});
