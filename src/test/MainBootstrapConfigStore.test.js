'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MainBootstrapConfigStore } = require('../lib/MainBootstrapConfigStore');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const key = byte => Buffer.alloc(32, byte).toString('base64');
const config = () => ({ version: 1, privateKey: key(1), publicKey: key(2),
  profile: generateOfficialProfile() });

test('Main bootstrap config is private, durable and never overwritten', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-main-config-'));
  try {
    await fs.chmod(directory, 0o700);
    const store = new MainBootstrapConfigStore(path.join(directory, 'config.json'));
    const first = config();
    await store.create(first);
    assert.deepEqual(await store.read(), first);
    await assert.rejects(store.create(config()), error => error.code === 'EEXIST');
    assert.deepEqual(await store.read(), first);
    if (process.platform !== 'win32') {
      const info = await fs.lstat(store.filePath);
      assert.equal(info.mode & 0o077, 0);
      await fs.chmod(store.filePath, 0o644);
      await assert.rejects(store.read(), /Unsafe Main bootstrap config/);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Main bootstrap config rejects extra fields before writing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-main-config-'));
  try {
    await fs.chmod(directory, 0o700);
    const store = new MainBootstrapConfigStore(path.join(directory, 'config.json'));
    await assert.rejects(store.create({ ...config(), userPort: 51820 }),
      /Invalid Main bootstrap config/);
    assert.equal(await store.read(), null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
