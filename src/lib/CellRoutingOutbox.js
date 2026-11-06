'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { routingViewFromTopology } = require('./CellRoutingView');
const { signRoutingRevision, verifyRoutingRevision } = require('./CellRoutingRevision');
const { verifyRoutingAck } = require('./CellRoutingAck');

const queues = new Map();

class CellRoutingOutbox {
  constructor(filePath, { identityStore, cellKey, nodeId }) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || !identityStore || typeof identityStore.load !== 'function'
      || typeof nodeId !== 'string') {
      throw new TypeError('Private routing outbox and identity required');
    }
    this.filePath = path.resolve(filePath);
    this.ackPath = `${this.filePath}.ack`;
    this.identityStore = identityStore;
    this.cellKey = cellKey;
    this.nodeId = nodeId;
  }

  exclusive(work) {
    const task = (queues.get(this.filePath) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.filePath, task);
    const done = () => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); };
    task.then(done, done);
    return task;
  }

  async load() {
    let raw;
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024
        || process.platform !== 'win32'
          && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
        throw new Error('Unsafe routing outbox');
      }
      const dir = await fs.lstat(path.dirname(this.filePath));
      if (!dir.isDirectory() || process.platform !== 'win32'
        && (dir.uid !== process.getuid() || (dir.mode & 0o077))) {
        throw new Error('Private routing outbox directory required');
      }
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const envelope = parseStateText(raw);
    const controller = await this.identityStore.load('controller');
    verifyRoutingRevision(envelope, { controllerKey: controller.publicKey,
      cellKey: this.cellKey, nodeId: this.nodeId });
    return envelope;
  }

  async save(envelope) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || process.platform !== 'win32'
      && (info.uid !== process.getuid() || (info.mode & 0o077))) {
      throw new Error('Private routing outbox directory required');
    }
    const temporary = path.join(dir, `.routing-outbox-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(encodeStateText(JSON.stringify(envelope), this.filePath)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(dir, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    }); }
  }

  async readAck() {
    let raw;
    try {
      const stat = await fs.lstat(this.ackPath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048
        || process.platform !== 'win32'
          && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
        throw new Error('Unsafe routing acknowledgement');
      }
      raw = await fs.readFile(this.ackPath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return parseStateText(raw);
  }

  applied() {
    return this.exclusive(async () => {
      const [desired, ack] = await Promise.all([this.load(), this.readAck()]);
      if (!desired || !ack || ack.revision !== desired.revision) return null;
      verifyRoutingAck(ack, desired);
      return desired.revision;
    });
  }

  acknowledge(input) {
    const ack = structuredClone(input);
    return this.exclusive(async () => {
      const desired = await this.load();
      if (!desired) throw new Error('No published routing revision');
      const result = verifyRoutingAck(ack, desired);
      const dir = path.dirname(this.ackPath);
      const info = await fs.lstat(dir);
      if (!info.isDirectory() || process.platform !== 'win32'
        && (info.uid !== process.getuid() || (info.mode & 0o077))) {
        throw new Error('Private routing acknowledgement directory required');
      }
      const temporary = path.join(dir, `.routing-ack-${crypto.randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(encodeStateText(JSON.stringify(ack), this.filePath)); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, this.ackPath);
        if (process.platform !== 'win32') {
          const parent = await fs.open(dir, 'r');
          try { await parent.sync(); } finally { await parent.close(); }
        }
      } finally { await fs.unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      }); }
      return result;
    });
  }

  publish(topology, { panel } = {}) {
    return this.exclusive(async () => {
      const view = routingViewFromTopology(topology, this.nodeId, { panel });
      const prior = await this.load();
      if (prior && prior.payload === JSON.stringify(view)) return prior;
      const controller = await this.identityStore.load('controller');
      const envelope = signRoutingRevision({ cellKey: this.cellKey,
        revision: (prior?.revision || 0) + 1, view }, controller.privateKey);
      await this.save(envelope);
      return envelope;
    });
  }
}

module.exports = { CellRoutingOutbox };
