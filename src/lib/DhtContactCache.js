'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const LIMIT = 128;
const safe = stat => stat.nlink === 1 && stat.isFile() && stat.size <= 16384
  && (process.platform === 'win32' || stat.uid === process.getuid() && !(stat.mode & 0o077));
const contact = node => node && net.isIP(node.host) === 4
  && Number.isInteger(node.port) && node.port > 0 && node.port <= 65535;

class DhtContactCache {
  constructor(directory) {
    if (!path.isAbsolute(directory)) throw new TypeError('Absolute DHT state directory required');
    this.directory = directory;
    this.file = path.join(directory, 'contacts.json');
  }
  async prepare() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32'
      && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Private DHT cache required');
  }
  async read() {
    await this.prepare();
    let info;
    try { info = await fs.lstat(this.file); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!safe(info)) throw new Error('Unsafe DHT cache');
    const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
    if (!state || state.version !== 1 || Object.keys(state).sort().join(',') !== 'nodes,version'
      || !Array.isArray(state.nodes) || state.nodes.length > LIMIT
      || state.nodes.some(node => !contact(node) || Object.keys(node).sort().join(',') !== 'host,port')) {
      throw new Error('Invalid DHT cache');
    }
    return state.nodes;
  }
  async write(nodes) {
    await this.prepare();
    if (!Array.isArray(nodes)) throw new TypeError('DHT contacts required');
    const remembered = await this.read();
    // Select a bounded, deduplicated subset; never persist BEP44 values or keys.
    const unique = new Map();
    // A transient partition or an empty routing table on shutdown must not
    // erase the last known entry points. Prefer current contacts when capped.
    for (const node of [...nodes, ...remembered]) {
      if (contact(node)) unique.set(`${node.host}:${node.port}`, { host: node.host, port: node.port });
      if (unique.size === LIMIT) break;
    }
    try { if (!safe(await fs.lstat(this.file))) throw new Error('Unsafe DHT cache'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(this.directory, `.contacts-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, nodes: [...unique.values()] })); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, this.file);
      if (process.platform !== 'win32') {
        const directory = await fs.open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}

module.exports = { DhtContactCache };
