'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyRoutingRevision } = require('./CellRoutingRevision');
const { assertRoutingMatchesAssignments } = require('./CellRoutingView');

const queues = new Map();
const MAX_FILE = 3 * 1024 * 1024;

// The caller must start with the data and routing guards in place. This journal
// records what has been received and what was actually applied; an unsuccessful
// revision is never acknowledged or replayed in place of the last good one.
class CellRoutingInbox {
  constructor(filePath, { controllerKey, cellKey, nodeId, assignments, apply }) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || typeof assignments !== 'function' || typeof apply !== 'function') {
      throw new TypeError('Private routing journal and adapters required');
    }
    this.filePath = path.resolve(filePath);
    this.trust = { controllerKey, cellKey, nodeId };
    this.assignments = assignments;
    this.apply = apply;
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
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE
        || process.platform !== 'win32'
          && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
        throw new Error('Unsafe routing journal');
      }
      const dir = await fs.lstat(path.dirname(this.filePath));
      if (!dir.isDirectory() || process.platform !== 'win32'
        && (dir.uid !== process.getuid() || (dir.mode & 0o077))) {
        throw new Error('Private routing journal directory required');
      }
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const state = JSON.parse(raw);
    if (!state || state.version !== 1 || !state.received
      || Object.keys(state).sort().join(',') !== 'applied,received,version') {
      throw new Error('Invalid routing journal');
    }
    const received = verifyRoutingRevision(state.received, this.trust);
    if (state.applied !== null) {
      const applied = verifyRoutingRevision(state.applied, this.trust);
      if (applied.revision > received.revision
        || applied.revision === received.revision && applied.hash !== received.hash) {
        throw new Error('Routing journal revision conflict');
      }
    }
    return state;
  }

  async save(state) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || process.platform !== 'win32'
      && (info.uid !== process.getuid() || (info.mode & 0o077))) {
      throw new Error('Private routing journal directory required');
    }
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes) > MAX_FILE) throw new Error('Routing journal too large');
    const temporary = path.join(dir, `.routing-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(dir, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    }); }
  }

  receive(input) {
    const envelope = structuredClone(input);
    return this.exclusive(async () => {
      const incoming = verifyRoutingRevision(envelope, this.trust);
      const view = assertRoutingMatchesAssignments(incoming.view, await this.assignments());
      const state = await this.load();
      if (state) {
        const prior = verifyRoutingRevision(state.received, this.trust);
        if (incoming.revision < prior.revision) throw new Error('Stale routing revision');
        if (incoming.revision === prior.revision && incoming.hash !== prior.hash) {
          throw new Error('Conflicting routing revision');
        }
        if (state.applied?.revision === incoming.revision) {
          return { received: incoming.revision, applied: incoming.revision };
        }
      }
      const next = { version: 1, received: envelope, applied: state?.applied || null };
      await this.save(next);
      await this.apply(view, incoming.revision);
      await this.save({ ...next, applied: envelope });
      return { received: incoming.revision, applied: incoming.revision };
    });
  }

  restoreApplied() {
    return this.exclusive(async () => {
      const state = await this.load();
      if (!state?.applied) return { applied: null };
      const prior = verifyRoutingRevision(state.applied, this.trust);
      const view = assertRoutingMatchesAssignments(prior.view, await this.assignments());
      await this.apply(view, prior.revision);
      return { applied: prior.revision };
    });
  }
}

module.exports = { CellRoutingInbox };
