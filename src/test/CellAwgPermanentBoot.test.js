'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureTunDevice } = require('../lib/CellTunPreflight');
const { recoverPermanentBoot } = require('../lib/CellAwgPermanentBoot');

test('TUN preflight loads only a missing module and verifies a character device', async () => {
  const calls = [];
  let present = false;
  const stat = async () => {
    if (!present) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
    return { isCharacterDevice: () => true };
  };
  const runner = async (file, args) => {
    calls.push([file, args]); present = true;
  };
  assert.deepEqual(await ensureTunDevice({ stat, runner, platform: 'linux' }),
    { ready: true, moduleLoaded: true });
  assert.deepEqual(await ensureTunDevice({ stat, runner, platform: 'linux' }),
    { ready: true, moduleLoaded: false });
  assert.deepEqual(calls, [['modprobe', ['tun']]]);
  await assert.rejects(ensureTunDevice({ stat: async () => ({ isCharacterDevice: () => false }),
    runner, platform: 'linux' }), /Unsafe/);
  await assert.rejects(ensureTunDevice({ stat, runner, platform: 'win32' }), /Linux/);
});

test('boot restores the path before last acknowledged cell settings', async () => {
  const events = [], plan = { version: 1 };
  let operational = false;
  const deployment = { stateDirectory: 'private', runner: async () => {},
    store: { read: async () => plan },
    resume: async () => { events.push('path'); },
    buildPath: () => ({ verifyOperational: async () => operational }) };
  const receiver = { restoreApplied: async () => { events.push('settings'); return { applied: 7 }; } };
  const args = { deployment, receiver, ensureTun: async () => { events.push('tun'); } };
  await assert.rejects(recoverPermanentBoot(args), /not operational/);
  assert.deepEqual(events, ['tun', 'path']);
  operational = true;
  assert.deepEqual(await recoverPermanentBoot(args), { configured: true, applied: 7 });
  assert.deepEqual(events, ['tun', 'path', 'tun', 'path', 'settings']);
});

test('unconfigured controller boot does not load TUN or invent a permanent plan', async () => {
  const deployment = { store: { read: async () => null }, resume: async () => {
    throw new Error('unexpected'); }, buildPath: () => { throw new Error('unexpected'); } };
  assert.deepEqual(await recoverPermanentBoot({ deployment,
    ensureTun: async () => { throw new Error('unexpected'); } }),
  { configured: false, applied: null });
});
