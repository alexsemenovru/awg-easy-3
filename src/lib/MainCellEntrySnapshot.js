'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateCellUserDescriptor } = require('./CellUserDescriptor');

const MAX_BYTES = 2 * 1024 * 1024;

function validateEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'entries,version'
    || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 1012) {
    throw new Error('Invalid Main Cell entry snapshot');
  }
  const seen = new Set();
  const entries = value.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !['descriptor,id', 'confirmed,descriptor,id'].includes(Object.keys(entry).sort().join(','))
      || typeof entry.id !== 'string' || !/^[a-f0-9]{32}$/.test(entry.id)
      || seen.has(entry.id)) throw new Error('Invalid Main Cell entry snapshot');
    seen.add(entry.id);
    const confirmed = entry.confirmed ?? {};
    if (!confirmed || typeof confirmed !== 'object' || Array.isArray(confirmed)
      || Object.keys(confirmed).length > 1000
      || Object.entries(confirmed).some(([clientId, fingerprint]) =>
        !/^[A-Za-z0-9_-]{1,64}$/.test(clientId) || !/^[a-f0-9]{64}$/.test(fingerprint))) {
      throw new Error('Invalid Main Cell entry confirmations');
    }
    return { id: entry.id, descriptor: entry.descriptor === null ? null
      : validateCellUserDescriptor(entry.descriptor), confirmed: { ...confirmed } };
  });
  return { version: 1, entries };
}

class MainCellEntrySnapshot {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new TypeError('Absolute Main Cell entry snapshot path required');
    }
    this.filePath = filePath;
  }

  async write(entries) {
    const value = validateEntries({ version: 1, entries });
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Main Cell entry snapshot too large');
    const directory = path.dirname(this.filePath);
    const dir = await fs.lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()
      || process.platform !== 'win32'
        && (dir.uid !== process.getuid() || (dir.mode & 0o077))) {
      throw new Error('Private Main Cell entry snapshot directory required');
    }
    const temporary = path.join(directory, `.main-cell-entry-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(data); await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async read() {
    const details = await this.readDetails();
    return Object.fromEntries(Object.entries(details).filter(([, entry]) => entry.descriptor)
      .map(([id, entry]) => [id, entry.descriptor]));
  }

  async readDetails() {
    let stat;
    try { stat = await fs.lstat(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES
      || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error('Unsafe Main Cell entry snapshot');
    }
    const value = validateEntries(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    return Object.fromEntries(value.entries.map(entry => [entry.id,
      { descriptor: entry.descriptor, confirmed: entry.confirmed }]));
  }
}

module.exports = { MainCellEntrySnapshot, validateEntries };
