'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareCellInstallationStateDirectory } = require('../lib/CellInstallationStateDirectory');

const linux = { skip: process.platform !== 'linux' && 'Linux ownership/mode checks required' };

test('creates a private persistent Cell directory and accepts its own existing directory', linux, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-state-'));
  try {
    const directory = path.join(parent, 'cell');
    assert.equal(await prepareCellInstallationStateDirectory(directory), directory);
    assert.equal((await fs.lstat(directory)).mode & 0o777, 0o700);
    assert.equal(await prepareCellInstallationStateDirectory(directory), directory);
  } finally { await fs.rm(parent, { recursive: true }); }
});

test('does not adopt a shared, foreign, or symlinked Cell directory', linux, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-state-'));
  try {
    const shared = path.join(parent, 'shared');
    await fs.mkdir(shared, { mode: 0o755 });
    await assert.rejects(prepareCellInstallationStateDirectory(shared), /Private Cell state directory/);
    assert.equal((await fs.lstat(shared)).mode & 0o777, 0o755);
    const link = path.join(parent, 'link');
    await fs.symlink(shared, link);
    await assert.rejects(prepareCellInstallationStateDirectory(link), /Private Cell state directory/);
    await fs.chmod(parent, 0o777);
    await assert.rejects(prepareCellInstallationStateDirectory(path.join(parent, 'new')),
      /parent must be owned/);
    await assert.rejects(fs.lstat(path.join(parent, 'new')), { code: 'ENOENT' });
  } finally { await fs.rm(parent, { recursive: true }); }
});

test('rejects nonpersistent or relative Cell state paths before filesystem changes', async () => {
  await assert.rejects(prepareCellInstallationStateDirectory('cell-state'), /Persistent absolute Linux/);
  await assert.rejects(prepareCellInstallationStateDirectory('/run/awg-cell'), /Persistent absolute Linux/);
});
