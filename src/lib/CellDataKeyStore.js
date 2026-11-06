'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateKey } = require('./AwgKeyManager');

function validateDataKeyAnnouncement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'publicKey,version'
    || value.version !== 1) throw new TypeError('Invalid Cell data key announcement');
  validateKey(value.publicKey, 'cellDataPublicKey');
  return Object.freeze({ version: 1, publicKey: value.publicKey });
}

// One immutable announcement per registered Cell. A changed key requires an
// explicit retirement/re-enrollment transition, never a routine control poll.
class CellDataKeyStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new TypeError('Absolute Cell data key path required');
    }
    this.filePath = filePath;
  }

  async read() {
    let stat;
    try { stat = await fs.lstat(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256
      || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error('Unsafe Cell data key announcement');
    }
    const directory = await fs.lstat(path.dirname(this.filePath));
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || process.platform !== 'win32'
        && (directory.uid !== process.getuid() || (directory.mode & 0o077))) {
      throw new Error('Private Cell data key directory required');
    }
    return validateDataKeyAnnouncement(parseStateText(await fs.readFile(this.filePath, 'utf8')));
  }

  async reserve(input) {
    const value = validateDataKeyAnnouncement(input);
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error('Private Cell data key directory required');
    }
    const temporary = path.join(directory, `.cell-data-key-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(encodeStateText(JSON.stringify(value), this.filePath)); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.link(temporary, this.filePath); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = await this.read();
        if (previous.publicKey !== value.publicKey) {
          throw new Error('Cell data public key changed; re-enrollment required');
        }
        return false;
      }
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      return true;
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

module.exports = { CellDataKeyStore, validateDataKeyAnnouncement };
