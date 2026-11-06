'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateKey } = require('./AwgKeyManager');

function validateIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'privateKey,publicKey,version'
    || value.version !== 1) throw new Error('Invalid Cell data identity');
  validateKey(value.privateKey, 'cellDataPrivateKey');
  validateKey(value.publicKey, 'cellDataPublicKey');
  return Object.freeze({ version: 1, privateKey: value.privateKey,
    publicKey: value.publicKey });
}

class CellDataIdentityStore {
  constructor(filePath, keyManager) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || !keyManager || typeof keyManager.generateKeyPair !== 'function'
      || typeof keyManager.derivePublicKey !== 'function') {
      throw new TypeError('Absolute Cell data identity path and AWG key manager required');
    }
    this.filePath = filePath;
    this.keyManager = keyManager;
  }

  async read() {
    let stat;
    try { stat = await fs.lstat(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512
      || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error('Unsafe Cell data identity');
    }
    const directory = await fs.lstat(path.dirname(this.filePath));
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || process.platform !== 'win32'
        && (directory.uid !== process.getuid() || (directory.mode & 0o077))) {
      throw new Error('Private Cell data identity directory required');
    }
    const value = validateIdentity(parseStateText(await fs.readFile(this.filePath, 'utf8')));
    if (await this.keyManager.derivePublicKey(value.privateKey) !== value.publicKey) {
      throw new Error('Cell data identity no longer matches its private key');
    }
    return value;
  }

  async ensure() {
    const previous = await this.read();
    if (previous) return previous;
    const pair = await this.keyManager.generateKeyPair();
    const value = validateIdentity({ version: 1, ...pair });
    if (await this.keyManager.derivePublicKey(value.privateKey) !== value.publicKey) {
      throw new Error('New Cell data identity did not verify');
    }
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error('Private Cell data identity directory required');
    }
    const temporary = path.join(directory, `.data-identity-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(encodeStateText(JSON.stringify(value), this.filePath)); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.link(temporary, this.filePath); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        return this.read();
      }
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      return value;
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

module.exports = { CellDataIdentityStore };
