'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runNftBatch } = require('../lib/NftBatchRunner');

test('checks and applies the same private nft batch, then removes it', async () => {
  const calls = [];
  let temporary;
  await runNftBatch(async (file, args) => {
    assert.equal(file, 'nft');
    temporary = args.at(-1);
    const directory = await fs.stat(path.dirname(temporary));
    const batch = await fs.stat(temporary);
    if (process.platform !== 'win32') {
      assert.equal(directory.mode & 0o077, 0);
      assert.equal(batch.mode & 0o077, 0);
    }
    calls.push([args.slice(0, -1), await fs.readFile(temporary, 'utf8')]);
  }, '{"nftables":[]}');
  assert.deepEqual(calls, [
    [['-c', '-j', '-f'], '{"nftables":[]}'],
    [['-j', '-f'], '{"nftables":[]}'],
  ]);
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.dirname(temporary)), { code: 'ENOENT' });
});

test('does not apply after failed check and removes temporary batch', async () => {
  let temporary, calls = 0;
  await assert.rejects(runNftBatch(async (_file, args) => {
    calls++; temporary = args.at(-1);
    throw new Error('invalid nft batch');
  }, '{}'), /invalid nft batch/);
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.dirname(temporary)), { code: 'ENOENT' });
});
