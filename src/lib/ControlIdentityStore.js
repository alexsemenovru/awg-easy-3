'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { identity } = require('./CellRegistration');

const invalid = () => { throw new Error('Invalid control identity; automatic replacement is disabled'); };

function validate(value) {
  try {
    if (!value || value.version !== 1 || !['controller', 'cell'].includes(value.role)
      || typeof value.privateKey !== 'string' || value.privateKey.length > 4096
      || typeof value.publicKey !== 'string') invalid();
    const key = crypto.createPrivateKey(value.privateKey);
    if (key.asymmetricKeyType !== 'ed25519'
      || crypto.createPublicKey(key).export({ format: 'jwk' }).x !== value.publicKey) invalid();
    return Object.freeze({ version: 1, role: value.role, publicKey: value.publicKey,
      privateKey: key.export({ type: 'pkcs8', format: 'pem' }) });
  } catch { invalid(); }
}

class ControlIdentityStore {
  constructor(filePath, { io = fs } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('Identity path required');
    this.filePath = path.resolve(filePath);
    this.io = io;
  }

  async load(expectedRole) {
    const stat = await this.io.lstat(this.filePath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192) invalid();
    if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error('Control identity permissions must exclude group and other users');
    }
    let parsed;
    try { parsed = JSON.parse(await this.io.readFile(this.filePath, 'utf8')); } catch { invalid(); }
    const result = validate(parsed);
    if (result.role !== expectedRole) throw new Error('Control identity role mismatch');
    return result;
  }

  // Explicit first-install operation. Never overwrite an existing identity,
  // including during concurrent initialization by different processes.
  async create(role) {
    const value = validate({ version: 1, role, ...identity() });
    const directory = path.dirname(this.filePath);
    await this.io.mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await this.io.lstat(directory);
    if (!parent.isDirectory() || (process.platform !== 'win32'
      && (parent.uid !== process.getuid() || (parent.mode & 0o077)))) {
      throw new Error('Private control identity directory required');
    }
    const temporary = path.join(directory, `.control-identity-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await this.io.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(value), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      // link publishes a complete file without rename's overwrite semantics.
      await this.io.link(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await this.io.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      return value;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await this.io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

module.exports = { ControlIdentityStore, validateControlIdentity: validate };
