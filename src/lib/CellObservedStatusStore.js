'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const queues = new Map();
const validPath = value => value === null || ['direct', 'technical'].includes(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
function validateObservedStatus(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'controlPath,issuedAt,receivedAt,version'
    || value.version !== 1 || !validPath(value.controlPath)
    || !timestamp(value.issuedAt) || !timestamp(value.receivedAt)) throw new Error('Invalid observed Cell status');
  return { version: 1, controlPath: value.controlPath, issuedAt: value.issuedAt, receivedAt: value.receivedAt };
}

// An observation of authenticated control traffic, not user surveillance or
// proof that its data path/Internet egress works. No client identifiers/counters.
class CellObservedStatusStore {
  constructor(filePath) {
    if (!path.isAbsolute(filePath)) throw new TypeError('Absolute Cell observation path required');
    this.filePath = filePath;
  }
  async read() {
    let stat;
    try { stat = await fs.lstat(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 || process.platform !== 'win32'
      && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Unsafe Cell observation');
    return validateObservedStatus(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
  }
  update(controlPath, issuedAt, receivedAt = Date.now()) {
    const next = validateObservedStatus({ version: 1, controlPath, issuedAt, receivedAt });
    const work = (queues.get(this.filePath) || Promise.resolve()).catch(() => {}).then(async () => {
      const previous = await this.read();
      // A replay/older signed poll cannot make a stale observation fresh.
      if (previous && (issuedAt <= previous.issuedAt || receivedAt < previous.receivedAt
        || controlPath === previous.controlPath && receivedAt - previous.receivedAt < 30000)) return false;
      const directory = path.dirname(this.filePath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Private Cell observation directory required');
      const temporary = path.join(directory, `.observed-${crypto.randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.filePath);
        if (process.platform !== 'win32') {
          const parent = await fs.open(directory, 'r');
          try { await parent.sync(); } finally { await parent.close(); }
        }
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return true;
    });
    queues.set(this.filePath, work);
    const done = () => { if (queues.get(this.filePath) === work) queues.delete(this.filePath); };
    work.then(done, done);
    return work;
  }
}
module.exports = { CellObservedStatusStore, validateObservedStatus };
