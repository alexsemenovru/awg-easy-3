'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildCellArtifacts } = require('./CellArtifacts');

const REQUIRED = ['interfaceName', 'wanInterface', 'privateKey', 'listenPort',
  'address4', 'ipv4Subnet', 'profile'];
const OPTIONAL = ['address6', 'ipv6Subnet', 'ipv6Mode'];

class CellUserConfigStore {
  constructor(filePath, { interfaceName, listenPort } = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || typeof interfaceName !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(interfaceName)
      || !Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
      throw new TypeError('Absolute Cell config path and reserved user interface/port required');
    }
    Object.assign(this, { filePath, interfaceName, listenPort });
  }

  validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== 1 || !value.server || typeof value.server !== 'object'
      || Array.isArray(value.server)
      || Object.keys(value).sort().join(',') !== 'server,version'
      || REQUIRED.some(key => !Object.hasOwn(value.server, key))
      || Object.keys(value.server).some(key => !REQUIRED.includes(key) && !OPTIONAL.includes(key))
      || value.server.interfaceName !== this.interfaceName
      || value.server.listenPort !== this.listenPort
      || !/^[a-zA-Z0-9_.-]{1,15}$/.test(value.server.wanInterface || '')
      || value.server.wanInterface === this.interfaceName) {
      throw new Error('Invalid or unreserved Cell user config');
    }
    // The empty assignment still compiles the full AWG and nftables config.
    // Do not accept a key/profile/subnet that would fail only after registration.
    buildCellArtifacts({ server: value.server, settings: { schema: 1, clients: [] } });
    return structuredClone(value);
  }

  async read() {
    let stat;
    try { stat = await fs.lstat(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192
      || (process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new Error('Unsafe Cell user config');
    }
    try { return this.validate(parseStateText(await fs.readFile(this.filePath, 'utf8'))); }
    catch { throw new Error('Invalid Cell user config'); }
  }

  async create(value) {
    const config = this.validate(value);
    const directory = path.dirname(this.filePath);
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (process.platform !== 'win32'
        && (info.uid !== process.getuid() || (info.mode & 0o077)))) {
      throw new Error('Private Cell state directory required');
    }
    const temporary = path.join(directory, `.cell-user-config-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(encodeStateText(JSON.stringify(config), this.filePath));
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

module.exports = { CellUserConfigStore };
