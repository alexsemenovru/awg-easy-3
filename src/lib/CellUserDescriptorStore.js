'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateCellUserDescriptor } = require('./CellUserDescriptor');

class CellUserDescriptorStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new TypeError('Absolute Cell descriptor path required');
    }
    this.filePath = filePath;
  }

  async read() {
    let stat;
    try { stat = await fs.lstat(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096
      || (process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new Error('Unsafe Cell descriptor');
    }
    return validateCellUserDescriptor(parseStateText(await fs.readFile(this.filePath, 'utf8')));
  }

  async update(value) {
    const descriptor = validateCellUserDescriptor(value);
    const previous = await this.read();
    if (previous && JSON.stringify(previous) === JSON.stringify(descriptor)) return false;
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new Error('Private Cell descriptor directory required');
    }
    const temporary = path.join(directory, `.cell-descriptor-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(encodeStateText(JSON.stringify(descriptor), this.filePath));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return true;
  }
}

module.exports = { CellUserDescriptorStore };
