'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AwgKeyManager, validateKey } = require('./AwgKeyManager');
const { validateDataLinkDescriptor } = require('./CellDataLinkConfig');

function validatePublicDataOffer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'descriptor,presharedKey,version'
    || value.version !== 1) throw new TypeError('Invalid public Cell data offer');
  const descriptor = validateDataLinkDescriptor(value.descriptor);
  validateKey(value.presharedKey, 'cellDataPresharedKey');
  return Object.freeze({ version: 1, descriptor, presharedKey: value.presharedKey });
}

async function validateStoredOffer(value, keyManager) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',')
      !== 'cellPublicKey,controllerPrivateKey,descriptor,presharedKey,version') {
    throw new Error('Invalid stored Cell data offer');
  }
  const publicOffer = validatePublicDataOffer({ version: value.version,
    descriptor: value.descriptor, presharedKey: value.presharedKey });
  validateKey(value.cellPublicKey, 'cellDataPublicKey');
  validateKey(value.controllerPrivateKey, 'mainDataPrivateKey');
  if (value.cellPublicKey === publicOffer.descriptor.controllerPublicKey
    || await keyManager.derivePublicKey(value.controllerPrivateKey)
      !== publicOffer.descriptor.controllerPublicKey) {
    throw new Error('Stored Cell data offer identity mismatch');
  }
  return Object.freeze({ ...publicOffer, cellPublicKey: value.cellPublicKey,
    controllerPrivateKey: value.controllerPrivateKey });
}

class CellDataOfferStore {
  constructor(filePath, keyManager = new AwgKeyManager()) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || !keyManager || typeof keyManager.derivePublicKey !== 'function') {
      throw new TypeError('Absolute Cell data offer path and AWG key manager required');
    }
    this.filePath = filePath;
    this.keyManager = keyManager;
  }

  async read() {
    let stat;
    try { stat = await fs.lstat(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192
      || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error('Unsafe Cell data offer');
    }
    const directory = await fs.lstat(path.dirname(this.filePath));
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || process.platform !== 'win32'
        && (directory.uid !== process.getuid() || (directory.mode & 0o077))) {
      throw new Error('Private Cell data offer directory required');
    }
    return validateStoredOffer(parseStateText(await fs.readFile(this.filePath, 'utf8')),
      this.keyManager);
  }

  async create(input) {
    const value = await validateStoredOffer(input, this.keyManager);
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error('Private Cell data offer directory required');
    }
    const temporary = path.join(directory, `.cell-data-offer-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(encodeStateText(JSON.stringify(value), this.filePath)); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.link(temporary, this.filePath); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = await this.read();
        if (JSON.stringify(previous) !== JSON.stringify(value)) {
          throw new Error('Cell data offer changed; explicit transition required');
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

  async publicOffer(expectedCellPublicKey) {
    const stored = await this.read();
    if (!stored) return null;
    if (stored.cellPublicKey !== expectedCellPublicKey) {
      throw new Error('Data offer differs from enrolled Cell data key');
    }
    return validatePublicDataOffer({ version: stored.version,
      descriptor: stored.descriptor, presharedKey: stored.presharedKey });
  }
}

module.exports = { CellDataOfferStore, validatePublicDataOffer, validateStoredOffer };
