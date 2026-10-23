'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validatePublicDataOffer } = require('./CellDataOfferStore');

function validateForCell(offer, server) {
  const value = validatePublicDataOffer(offer);
  if (!server || value.descriptor.cellClientSubnet4 !== server.ipv4Subnet
    || value.descriptor.cellAddress6
      && (!server.address6 || !server.ipv6Subnet
        || value.descriptor.cellClientSubnet6 !== server.ipv6Subnet)) {
    throw new Error('Data offer does not match this Cell user tunnel');
  }
  return value;
}

// The signed control exchange authenticates the offer before reserve(). This
// private journal prevents a routine poll from silently changing an existing
// endpoint, PSK or address pair after the data AWG plan was installed.
class CellReceivedDataOfferStore {
  constructor(filePath, server) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !server) {
      throw new TypeError('Absolute received-offer path and Cell server required');
    }
    this.filePath = filePath;
    this.server = server;
  }
  async privateDirectory() {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error('Private received-offer directory required');
    }
    return directory;
  }
  async read() {
    let stat;
    try { stat = await fs.lstat(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192
      || process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error('Unsafe received Cell data offer');
    }
    await this.privateDirectory();
    try { return validateForCell(JSON.parse(await fs.readFile(this.filePath, 'utf8')),
      this.server); }
    catch { throw new Error('Unreadable received Cell data offer; replacement disabled'); }
  }
  async reserve(input) {
    const value = validateForCell(input, this.server);
    const directory = await this.privateDirectory();
    const temporary = path.join(directory, `.received-data-offer-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.link(temporary, this.filePath); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const old = await this.read();
        if (JSON.stringify(old) !== JSON.stringify(value)) {
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
}

module.exports = { CellReceivedDataOfferStore, validateForCell };
