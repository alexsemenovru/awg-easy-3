'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { targetFor, verifyCellLocator } = require('./CellDhtLocator');

const queues = new Map();
const validSeq = seq => Number.isSafeInteger(seq) && seq >= 0;

class CellDhtCursorStore {
  constructor(filePath, cellKey, { kind = 'cell' } = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new TypeError('Absolute DHT cursor path required');
    }
    targetFor(cellKey);
    if (!['cell', 'main'].includes(kind)) throw new TypeError('Invalid DHT identity role');
    this.filePath = path.resolve(filePath);
    this.cellKey = cellKey;
    this.kind = kind;
  }

  exclusive(work) {
    const task = (queues.get(this.filePath) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.filePath, task);
    const done = () => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); };
    task.then(done, done);
    return task;
  }

  async read() {
    let raw;
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256
        || process.platform !== 'win32'
          && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
        throw new Error('Unsafe DHT cursor');
      }
      const dir = await fs.lstat(path.dirname(this.filePath));
      if (!dir.isDirectory() || process.platform !== 'win32'
        && (dir.uid !== process.getuid() || (dir.mode & 0o077))) {
        throw new Error('Private DHT cursor directory required');
      }
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    const state = parseStateText(raw);
    if (!state || state.version !== 1 || state.cellKey !== this.cellKey
      || !validSeq(state.seq) || Object.keys(state).sort().join(',') !== 'cellKey,seq,version') {
      throw new Error('Invalid DHT cursor');
    }
    return state.seq;
  }

  async write(seq) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || process.platform !== 'win32'
      && (info.uid !== process.getuid() || (info.mode & 0o077))) {
      throw new Error('Private DHT cursor directory required');
    }
    const temporary = path.join(dir, `.dht-cursor-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(encodeStateText(JSON.stringify({ version: 1, cellKey: this.cellKey, seq }), this.filePath));
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(dir, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    }); }
  }

  reserve(now = Date.now()) {
    return this.exclusive(async () => {
      if (!Number.isSafeInteger(now) || now < 1) throw new Error('Invalid DHT sequence clock');
      const last = await this.read();
      const seq = Math.max(now, last + 1);
      if (!validSeq(seq)) throw new Error('DHT sequence exhausted');
      await this.write(seq);
      return seq;
    });
  }

  accept(item, now = Date.now()) {
    return this.exclusive(async () => {
      const last = await this.read();
      const locator = verifyCellLocator(item, { cellKey: this.cellKey,
        minimumSeq: last, kind: this.kind, now });
      if (locator.seq > last) await this.write(locator.seq);
      return locator;
    });
  }
}

module.exports = { CellDhtCursorStore };
