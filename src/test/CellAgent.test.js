'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CellAgent } = require('../lib/CellAgent');

test('agent restores before syncing, backs off without losing last successful status, recovers', async () => {
  const events = [];
  let callback;
  const delays = [];
  let failure = false;
  const agent = new CellAgent({ restore: async () => events.push('restore'),
    sync: async () => { events.push('sync'); if (failure) throw new Error('offline'); return { revision: 2 }; },
    intervalMs: 100, maxBackoffMs: 400,
    schedule: (cb, delay) => { callback = cb; delays.push(delay); return 1; }, cancel: () => events.push('cancel') });
  await agent.start();
  assert.deepEqual(events, ['restore', 'sync']);
  assert.equal(agent.status.revision, 2);
  const confirmed = agent.status.lastConfirmedAt;
  failure = true;
  callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(agent.status.state, 'sync-failed');
  assert.equal(agent.status.lastConfirmedAt, confirmed);
  assert.equal(agent.status.revision, 2);
  assert.deepEqual(delays, [100, 200]);
  failure = false;
  callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(agent.status.state, 'connected');
  await agent.stop();
  assert.equal(agent.status.state, 'stopped');
});

test('stop during outstanding sync prevents scheduling or overlapping work', async () => {
  let finish;
  let calls = 0;
  let scheduled = 0;
  const agent = new CellAgent({ restore: async () => {}, sync: () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  }, schedule: () => { scheduled++; } });
  const starting = agent.start();
  await new Promise(resolve => setImmediate(resolve));
  await agent.tick();
  assert.equal(calls, 1);
  const stopped = agent.stop();
  finish({ revision: 1 });
  await Promise.all([starting, stopped]);
  assert.equal(scheduled, 0);
  assert.equal(agent.status.state, 'stopped');
});

test('restore failure is explicit and never starts remote sync', async () => {
  let calls = 0;
  const agent = new CellAgent({ restore: async () => { throw new Error('invalid saved state'); },
    sync: async () => { calls++; } });
  await assert.rejects(agent.start(), /invalid saved/);
  assert.equal(calls, 0);
  assert.equal(agent.status.state, 'restore-failed');
});
