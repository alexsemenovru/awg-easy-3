'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { identity, signRegistration, verifyRegistration } = require('../lib/CellRegistration');
const { createInvitation, decodeInvitation } = require('../lib/CellInvitation');

async function fixture(t, io) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-identity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'identity.json');
  return { file, directory, store: new ControlIdentityStore(file, io ? { io } : {}) };
}

test('control identity survives reopening and signs registration', async t => {
  const { file, store } = await fixture(t);
  const created = await store.create('cell');
  const loaded = await new ControlIdentityStore(file).load('cell');
  assert.deepEqual(loaded, created);
  const controller = identity();
  const invitation = decodeInvitation(createInvitation({ host: '192.0.2.1', port: 12345,
    controllerKey: controller.publicKey, now: 1000 }).code, 1000);
  const proof = signRegistration(invitation, loaded.privateKey, 1001);
  assert.equal(verifyRegistration(proof, controller.publicKey, 1002).cellKey, created.publicKey);
  await assert.rejects(store.load('controller'), /role mismatch/);
});

test('missing and corrupt keys never silently regenerate', async t => {
  const { file, store } = await fixture(t);
  await assert.rejects(store.load('cell'), { code: 'ENOENT' });
  for (const raw of ['{', JSON.stringify({ version: 2, role: 'cell', ...identity() }),
    JSON.stringify({ version: 1, role: 'cell', ...identity(), publicKey: identity().publicKey })]) {
    await fs.writeFile(file, raw, { mode: 0o600 });
    await assert.rejects(store.load('cell'), /Invalid control identity/);
    await assert.rejects(store.create('cell'), { code: 'EEXIST' });
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
});

test('concurrent initialization publishes exactly one complete identity', async t => {
  const { file, directory, store } = await fixture(t);
  const results = await Promise.allSettled([store.create('controller'),
    new ControlIdentityStore(file).create('controller')]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.deepEqual(await store.load('controller'), results.find(x => x.status === 'fulfilled').value);
  assert.deepEqual(await fs.readdir(directory), ['identity.json']);
});

test('sync failure leaves no published identity or temporary secret', async t => {
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: (...values) => handle.writeFile(...values), close: () => handle.close(),
      sync: async () => { throw new Error('injected sync failure'); } };
  } };
  const { store, directory } = await fixture(t, io);
  await assert.rejects(store.create('cell'), /sync failure/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('Linux identity permissions exclude other users', { skip: process.platform === 'win32' }, async t => {
  const { store, file } = await fixture(t);
  await store.create('cell');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.chmod(file, 0o644);
  await assert.rejects(store.load('cell'), /permissions/);
});

test('identity load refuses hard links instead of reading a shared private key', async t => {
  const { store, file, directory } = await fixture(t);
  await store.create('cell');
  const link = path.join(directory, 'identity-copy.json');
  await fs.link(file, link);
  await assert.rejects(store.load('cell'), /Invalid control identity/);
});

test('identity creation refuses a non-private existing directory without changing it',
  { skip: process.platform === 'win32' }, async t => {
    const { store, directory } = await fixture(t);
    await fs.chmod(directory, 0o755);
    await assert.rejects(store.create('cell'), /Private control identity directory/);
    assert.equal((await fs.lstat(directory)).mode & 0o777, 0o755);
    assert.deepEqual(await fs.readdir(directory), []);
  });
