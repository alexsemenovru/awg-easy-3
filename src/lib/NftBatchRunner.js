'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// nft reopens /dev/stdin for `-f -`; Node's child stdin is not always a
// reopenable pipe (observed with Ubuntu nft in WSL). Keep one validated batch
// on a private file for both check and apply, then remove it on every exit.
async function runNftBatch(runner, input) {
  if (typeof runner !== 'function' || typeof input !== 'string' || !input.length) {
    throw new TypeError('Nft runner and nonempty batch required');
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-nft-'));
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
