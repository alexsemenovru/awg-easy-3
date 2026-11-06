'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { enabled, withUnlinkedFile } = require('./PrivateStateText');

// nft reopens /dev/stdin for `-f -`; Node's child stdin is not always a
// reopenable pipe (observed with Ubuntu nft in WSL). Keep one validated batch
// on a private file for both check and apply, then remove it on every exit.
async function runNftBatch(runner, input, stateDirectory) {
  if (typeof runner !== 'function' || typeof input !== 'string' || !input.length
    || typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)) {
    throw new TypeError('Nft runner, nonempty batch and absolute state directory required');
  }
  const parent = await fs.lstat(stateDirectory);
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || (process.platform !== 'win32'
      && (parent.uid !== process.getuid() || (parent.mode & 0o077)))) {
    throw new Error('Private nft state directory required');
  }
  if (enabled(path.join(stateDirectory, 'batch.json'))) {
    // Regular unlinked inode: nft can reopen it through the parent /proc fd.
    // Large GeoIP batches need no extra RAM-backed filesystem allocation.
    return withUnlinkedFile(stateDirectory, input, async file => {
      await runner('nft', ['-c', '-j', '-f', file]);
      await runner('nft', ['-j', '-f', file]);
    });
  }
  // The container's /tmp is intentionally small; GeoIP batches can exceed it.
  const directory = await fs.mkdtemp(path.join(stateDirectory, '.nft-batch-'));
  const batch = path.join(directory, 'batch.json');
  try {
    await fs.writeFile(batch, input, { flag: 'wx', mode: 0o600 });
    await runner('nft', ['-c', '-j', '-f', batch]);
    await runner('nft', ['-j', '-f', batch]);
  } finally {
    try { await fs.unlink(batch); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rmdir(directory);
  }
}

module.exports = { runNftBatch };
