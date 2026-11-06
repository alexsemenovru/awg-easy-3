'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { enabled, encodeStateText, decodeStateText, prepareCellStateFiles, openCommandFile } = require('../lib/PrivateStateText');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { CellSettingsReceiver } = require('../lib/CellSettingsReceiver');
const { CellAwgLifecycle } = require('../lib/CellAwgLifecycle');
const { signSettings } = require('../lib/CellSettings');
const { identity } = require('../lib/CellRegistration');
async function scope(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-state-'));
  const previous = { AWG_PRIVATE_STATE: process.env.AWG_PRIVATE_STATE, AWG_CELL_STATE_DIR: process.env.AWG_CELL_STATE_DIR };
  process.env.AWG_PRIVATE_STATE = '1'; process.env.AWG_CELL_STATE_DIR = directory;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
test('private state changes its visible signature per release, keeps legacy compatibility and rejects damage', async t => {
  const directory = await scope(t), file = path.join(directory, 'settings.json');
  const plain = '{"USERS":12,"PROTOCOLVERSION":6,"address":"192.0.2.8"}';
  const first = encodeStateText(plain, file, '0.1.6'), second = encodeStateText(plain, file, '0.1.7');
  assert.equal(first.includes('USERS'), false); assert.equal(first.includes('192.0.2.8'), false);
  assert.notEqual(first.slice(0, 17), second.slice(0, 17));
  assert.equal(decodeStateText(first), plain); assert.equal(decodeStateText(second), plain);
  assert.equal(decodeStateText(plain), plain);
  assert.throws(() => decodeStateText(first.slice(0, -3)), /decoded/);
  assert.equal(enabled(path.join(directory, '..', 'outside.json')), false);
  assert.equal(encodeStateText(plain, path.join(directory, '..', 'outside.json')), plain);
});
test('Cell identities, signed settings and ownership journals survive process-style reopening without plaintext fields', async t => {
  const directory = await scope(t), identityFile = path.join(directory, 'identity.json');
  const first = await new ControlIdentityStore(identityFile).create('cell');
  assert.equal((await fs.readFile(identityFile, 'utf8')).includes('PRIVATE KEY'), false);
  assert.equal((await new ControlIdentityStore(identityFile).load('cell')).privateKey, first.privateKey);
  const main = identity(), file = path.join(directory, 'settings.json');
  let applied = 0;
  const options = { controllerKey: main.publicKey, cellKey: first.publicKey, apply: async () => { applied++; } };
  await new CellSettingsReceiver(file, options).receive(signSettings({ cellKey: first.publicKey,
    revision: 1, settings: { schema: 1, clients: [] } }, main.privateKey));
  assert.equal((await fs.readFile(file, 'utf8')).includes('clients'), false);
  assert.deepEqual(await new CellSettingsReceiver(file, options).restoreApplied(), { applied: 1 });
  assert.equal(applied, 2);
  const journal = path.join(directory, 'lifecycle.json');
  await new CellAwgLifecycle({ journalPath: journal, activateGuard: async () => {} }).save({ version: 1, phase: 'empty', spec: null, blankHash: null });
  assert.equal((await fs.readFile(journal, 'utf8')).includes('phase'), false);
  assert.equal((await new CellAwgLifecycle({ journalPath: journal, activateGuard: async () => {} }).load()).phase, 'empty');
});
test('startup rotates existing legacy metadata under the installation lock', { skip: process.platform !== 'linux' }, async t => {
  const directory = await scope(t), file = path.join(directory, 'identity.json');
  const value = { version: 1, role: 'cell', ...identity() };
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await prepareCellStateFiles();
  assert.equal((await fs.readFile(file, 'utf8')).startsWith('~'), true);
  assert.equal((await new ControlIdentityStore(file).load('cell')).privateKey, value.privateKey);
});
test('command input has no directory entry and a child can reopen its proc descriptor', { skip: process.platform !== 'linux' }, async t => {
  const directory = await scope(t);
  const input = await openCommandFile(directory, 'synthetic-nft-batch');
  try {
    assert.deepEqual(await fs.readdir(directory), []);
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const result = await promisify(execFile)('cat', [input.file], { encoding: 'utf8' });
    assert.equal(result.stdout, 'synthetic-nft-batch');
  } finally { await input.close(); }
  await assert.rejects(fs.readFile(input.file));
});
