'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { nftFingerprint } = require('./CellNftOwnership');
const { runProcess } = require('./ProcessRunner');
const { TABLE_NAME } = require('./NftablesPolicy');
const MAX_NFT_READBACK_BYTES = 64 * 1024 * 1024;

const valid = value => value && value.version === 1 && value.table === TABLE_NAME
  && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
  && Object.keys(value).sort().join(',') === 'fingerprint,table,version';

// Hash-only receipt of the last successfully applied kernel policy. This
// detects accidental/foreign replacement; it is not a substitute for an
// installation-wide lock or protection against another root process.
class CellNftPolicyReceipt {
  constructor({ filePath, runner = runProcess }) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || process.platform !== 'win32' && /^\/run(?:\/|$)/.test(filePath)
      || typeof runner !== 'function') {
      throw new TypeError('Persistent absolute nft receipt path and runner required');
    }
    this.filePath = filePath;
    this.runner = runner;
  }

  async read() {
    let info;
    try { info = await fs.lstat(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.nlink !== 1 || info.size > 512
      || process.platform !== 'win32'
        && (info.uid !== process.getuid() || (info.mode & 0o077))) {
      throw new Error('Unsafe cell nft receipt');
    }
    const directory = await fs.lstat(path.dirname(this.filePath));
    if (!directory.isDirectory() || process.platform !== 'win32'
      && (directory.uid !== process.getuid() || (directory.mode & 0o077))) {
      throw new Error('Private cell nft receipt directory required');
    }
    const value = parseStateText(await fs.readFile(this.filePath, 'utf8'));
    if (!valid(value)) throw new Error('Invalid cell nft receipt');
    return value;
  }

  async write(fingerprint) {
    const value = { version: 1, table: TABLE_NAME, fingerprint };
    if (!valid(value)) throw new TypeError('Invalid cell nft fingerprint');
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || process.platform !== 'win32'
      && (info.uid !== process.getuid() || (info.mode & 0o077))) {
      throw new Error('Private cell nft receipt directory required');
    }
    const temporary = path.join(directory, `.nft-receipt-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(encodeStateText(JSON.stringify(value), this.filePath)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    }); }
  }

  async currentFingerprint() {
    const inventory = JSON.parse((await this.runner('nft', ['-j', 'list', 'tables'])).stdout);
    if (!inventory || !Array.isArray(inventory.nftables)) throw new Error('Invalid nft inventory');
    let found = false;
    for (const item of inventory.nftables) {
      if (!item || typeof item !== 'object' || Object.keys(item).length !== 1
        || !item.table && !item.metainfo) throw new Error('Invalid nft inventory');
      if (item.table?.family === 'inet' && item.table.name === TABLE_NAME) found = true;
    }
    if (!found) return null;
    return nftFingerprint(JSON.parse((await this.runner('nft',
      ['-j', 'list', 'table', 'inet', TABLE_NAME],
      { maxOutputBytes: MAX_NFT_READBACK_BYTES })).stdout), TABLE_NAME);
  }

  async assertKnown() {
    const current = await this.currentFingerprint();
    if (current === null) return;
    const saved = await this.read();
    if (!saved || saved.fingerprint !== current) {
      throw new Error('Foreign or changed cell nft table; refusing replacement');
    }
  }

  async recordCurrent() {
    const current = await this.currentFingerprint();
    if (current === null) throw new Error('Applied cell nft table is missing');
    await this.write(current);
  }

  async matchesCurrent() {
    const saved = await this.read();
    return !!saved && saved.fingerprint === await this.currentFingerprint();
  }
}

module.exports = { CellNftPolicyReceipt };
