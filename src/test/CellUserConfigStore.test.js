'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CellUserConfigStore } = require('../lib/CellUserConfigStore');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const config = () => ({ version: 1, server: {
  interfaceName: 'awgcellu8', wanInterface: 'eth0',
  privateKey: Buffer.alloc(32, 7).toString('base64'), listenPort: 51830,
  address4: '10.88.8.1', ipv4Subnet: '10.88.8.0/24',
  profile: generateOfficialProfile(),
} });

test('Cell user config is private, immutable, and bound to reserved resources', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-user-store-'));
  const store = new CellUserConfigStore(path.join(dir, 'user-config.json'), {
    interfaceName: 'awgcellu8', listenPort: 51830 });
  try {
    const installed = config();
    assert.equal(await store.read(), null);
    await store.create(installed);
    assert.deepEqual(await store.read(), installed);
    await assert.rejects(store.create(installed), { code: 'EEXIST' });
    assert.deepEqual(await store.read(), installed);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(store.filePath)).mode & 0o077, 0);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Cell user config rejects cross-service collision and malformed fields', () => {
  const store = new CellUserConfigStore(path.resolve('cell-user-config.json'), {
    interfaceName: 'awgcellu8', listenPort: 51830 });
  assert.throws(() => store.validate({ ...config(), server: {
    ...config().server, interfaceName: 'awgforeign',
  } }), /unreserved/);
  assert.throws(() => store.validate({ ...config(), server: {
    ...config().server, listenPort: 51820,
  } }), /unreserved/);
  assert.throws(() => store.validate({ ...config(), server: {
    ...config().server, extra: 'not allowed',
  } }), /unreserved/);
  assert.throws(() => store.validate({ ...config(), server: {
    ...config().server, ipv4Subnet: '10.88.9.0/24',
  } }), /subnet/);
});

test('Cell user config refuses symlinks and loose file permissions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-user-store-'));
  const store = new CellUserConfigStore(path.join(dir, 'user-config.json'), {
    interfaceName: 'awgcellu8', listenPort: 51830 });
  try {
    await fs.writeFile(path.join(dir, 'source'), JSON.stringify(config()), { mode: 0o600 });
    await fs.symlink(path.join(dir, 'source'), store.filePath);
    await assert.rejects(store.read(), /Unsafe/);
    await fs.unlink(store.filePath);
    await fs.writeFile(store.filePath, JSON.stringify(config()), { mode: 0o600 });
    if (process.platform !== 'win32') {
      await fs.chmod(store.filePath, 0o644);
      await assert.rejects(store.read(), /Unsafe/);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
