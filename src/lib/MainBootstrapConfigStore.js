'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateKey } = require('./AwgKeyManager');
const { validateProfile } = require('./Awg3Config');

class MainBootstrapConfigStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new TypeError('Absolute Main bootstrap config path required');
    }
    this.filePath = filePath;
  }

  validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'privateKey,profile,publicKey,version'
      || value.version !== 1) throw new Error('Invalid Main bootstrap config');
    validateKey(value.privateKey, 'privateKey');
    validateKey(value.publicKey, 'publicKey');
    const profile = validateProfile(value.profile);
    if (Object.keys(profile).sort().join(',') !== Object.keys(value.profile).sort().join(',')) {
      throw new Error('Invalid Main bootstrap profile');
    }
    return { version: 1, privateKey: value.privateKey, publicKey: value.publicKey, profile };
  }

  async read() {
    let stat;
    try { stat = await fs.lstat(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192
      || (process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new Error('Unsafe Main bootstrap config');
    }
    let value;
    try { value = JSON.parse(await fs.readFile(this.filePath, 'utf8')); }
    catch { throw new Error('Invalid Main bootstrap config'); }
    return this.validate(value);
  }

  async create(value) {
    const config = this.validate(value);
    const directory = path.dirname(this.filePath);
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (process.platform !== 'win32'
        && (info.uid !== process.getuid() || (info.mode & 0o077)))) {
      throw new Error('Private Main bootstrap directory required');
    }
    const temporary = path.join(directory, `.main-config-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(config));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.link(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return config;
  }
}

module.exports = { MainBootstrapConfigStore };
