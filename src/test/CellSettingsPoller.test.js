'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CellSettingsPoller } = require('../lib/CellSettingsPoller');

test('poller retains service across failures and backs off without exposing error details', async () => {
  let attempts = 0, clock = 100;
  const delays = [], statuses = [];
  let poller;
  poller = new CellSettingsPoller({ intervalMs: 1000, maxBackoffMs: 5000,
    random: () => 0.5,
    now: () => clock++,
    sync: async () => { attempts++;
      if (attempts <= 2) throw new Error('secret client address'); },
    sleep: async ms => { delays.push(ms); },
    onStatus: status => { statuses.push(status);
      if (status.state === 'connected') poller.controller.abort(); } });
  await poller.start();
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(statuses.map(value => value.state), [
    'polling', 'degraded', 'polling', 'degraded', 'polling', 'connected', 'stopped']);
  assert.equal(statuses.at(-2).consecutiveFailures, 0);
  assert.ok(!JSON.stringify(statuses).includes('secret'));
});

test('poller allows one instance and stops a pending wait without another sync', async () => {
  let attempts = 0, waiting;
  const poller = new CellSettingsPoller({ sync: async () => { attempts++; },
    sleep: async (ms, signal) => new Promise(resolve => {
      waiting = resolve;
      signal.addEventListener('abort', resolve, { once: true });
    }) });
  const running = poller.start();
  assert.throws(() => poller.start(), /already running/);
  while (!waiting) await new Promise(resolve => setImmediate(resolve));
  await poller.stop();
  await running;
  assert.equal(attempts, 1);
  assert.equal(poller.status.state, 'stopped');
  await poller.stop();
});

test('status callback failure never interrupts settings sync', async () => {
  let poller, attempts = 0;
  poller = new CellSettingsPoller({ sync: async () => { attempts++; },
    onStatus: status => { if (status.state === 'polling') throw new Error('UI unavailable');
      if (status.state === 'connected') poller.controller.abort(); } });
  await poller.start();
  assert.equal(attempts, 1);
});

test('stop requested on first status prevents the initial network poll', async () => {
  let attempts = 0, poller;
  poller = new CellSettingsPoller({ sync: async () => { attempts++; },
    onStatus: status => { if (status.state === 'polling') poller.controller.abort(); } });
  await poller.start();
  assert.equal(attempts, 0);
});

test('poll jitter spreads retries while respecting the configured ceiling', async () => {
  let poller, delay;
  poller = new CellSettingsPoller({ intervalMs: 4000, maxBackoffMs: 5000,
    random: () => 0.999,
    sync: async () => { throw new Error('offline'); },
    sleep: async ms => { delay = ms; poller.controller.abort(); } });
  await poller.start();
  assert.ok(delay > 4000 && delay <= 5000);
});
test('stopping cancels the in-flight control poll without waiting for its timeout', async () => {
  let begun;
  const ready = new Promise(resolve => { begun = resolve; });
  const poller = new CellSettingsPoller({ sync: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    begun();
  }) });
  poller.start();
  await ready;
  await poller.stop();
  assert.equal(poller.status.state, 'stopped');
});
