'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openCellSettingsRuntime } = require('../lib/CellSettingsRuntime');
const { CellRuntimeAdapter } = require('../lib/CellRuntimeAdapter');
const { CellSettingsReceiver } = require('../lib/CellSettingsReceiver');

const options = () => ({
  connectionStore: { read: async () => ({ status: 'registered',
    cellKey: Buffer.alloc(32, 1).toString('base64url'),
    controllerKey: Buffer.alloc(32, 2).toString('base64url') }) },
  stateDirectory: path.resolve('private-cell-state'),
  runtimeDirectory: path.resolve('cell-runtime'),
  server: { interfaceName: 'awgcell0' },
});

test('settings assembly binds registered identity, receiver and durable cell guard', async () => {
  const input = options();
  const { adapter, receiver } = await openCellSettingsRuntime(input);
  assert.ok(adapter instanceof CellRuntimeAdapter);
  assert.ok(receiver instanceof CellSettingsReceiver);
  assert.equal(receiver.trust.cellKey, (await input.connectionStore.read()).cellKey);
  assert.equal(receiver.trust.controllerKey, (await input.connectionStore.read()).controllerKey);
  assert.equal(receiver.filePath, path.join(input.stateDirectory, 'settings.json'));
  assert.equal(adapter.guard.file,
    path.join(input.stateDirectory, 'client-runtime', 'guard.json'));
});

test('settings assembly refuses missing registration and ambiguous directories', async () => {
  const input = options();
  await assert.rejects(openCellSettingsRuntime({ ...input,
    connectionStore: { read: async () => ({ status: 'pending' }) } }),
  /Registered cell connection required/);
  await assert.rejects(openCellSettingsRuntime({ ...input,
    stateDirectory: 'relative' }), /absolute runtime directories/);
  await assert.rejects(openCellSettingsRuntime({ ...input,
    runtimeDirectory: 'relative' }), /absolute runtime directories/);
  if (process.platform !== 'win32') {
    await assert.rejects(openCellSettingsRuntime({ ...input,
      stateDirectory: '/run/cell' }), /Persistent absolute/);
  }
});
