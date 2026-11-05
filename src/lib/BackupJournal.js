'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const queues = new Map();
async function privateDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32'
    && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Private backup journal directory required');
}
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
// Small, local journals only. Callers validate exact schemas, signatures and
// monotonic transitions; no remote path, command or private archive key is read.
class BackupJournal {
  constructor(filePath, validate, limit = 128 * 1024) {
    if (!path.isAbsolute(filePath) || typeof validate !== 'function') throw new TypeError('Backup journal path/schema required');
    this.filePath = filePath;
    this.validate = validate;
    this.limit = limit;
  }
  async read() {
    let handle;
    try {
      await privateDirectory(path.dirname(this.filePath));
      handle = await fs.open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.limit || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Unsafe backup journal');
      const bytes = await handle.readFile();
      if (bytes.length > this.limit) throw new Error('Backup journal too large');
      return this.validate(JSON.parse(bytes.toString('utf8')));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { if (handle) await handle.close(); }
  }
  async write(input) {
    const value = this.validate(structuredClone(input));
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > this.limit) throw new Error('Backup journal too large');
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await privateDirectory(directory);
    const temporary = path.join(directory, `.backup-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.filePath);
      await syncDirectory(directory);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return value;
  }
  exclusive(work) {
    const task = (queues.get(this.filePath) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.filePath, task);
    const done = () => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); };
    task.then(done, done);
    return task;
  }
}
module.exports = { BackupJournal, privateDirectory, syncDirectory };
