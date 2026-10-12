'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { withCellInstallationLock } = require('../lib/CellInstallationLock');

test('cell lock rejects ambiguous inputs', async () => {
  await assert.rejects(withCellInstallationLock({ lockPath: 'relative',
    work: async () => {} }), /Linux persistent/);
  await assert.rejects(withCellInstallationLock({ lockPath: '/run/cell.lock',
    work: async () => {} }), /Linux persistent/);
});

test('Linux cell lock excludes a second operation and releases after failure',
  { skip: process.platform !== 'linux' }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-lock-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const lockPath = path.join(directory, 'install.lock');
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const first = withCellInstallationLock({ lockPath, work: async () => {
      entered(); await blocked; throw new Error('injected operation failure');
    } });
    await started;
    await assert.rejects(withCellInstallationLock({ lockPath,
      work: async () => { throw new Error('must not execute'); } }), /already locked|already.*active/);
    release();
    await assert.rejects(first, /injected operation failure/);
    assert.equal(await withCellInstallationLock({ lockPath,
      work: async () => 'recovered' }), 'recovered');
  });

test('Linux cell lock refuses a world-readable state directory',
  { skip: process.platform !== 'linux' }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-lock-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.chmod(directory, 0o755);
    await assert.rejects(withCellInstallationLock({ lockPath: path.join(directory, 'lock'),
      work: async () => {} }), /Private cell installation/);
  });
