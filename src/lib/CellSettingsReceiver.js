'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifySettings } = require('./CellSettings');
const { validateCellSettings } = require('./CellSettingsSchema');
const { validEpochJournal, receivingState, sameEpoch, appliedState } = require('./CellControlAuthority');
const queues = new Map();

// apply must be idempotent, transactional for VPN/firewall, and reject failures.
// validate must check the complete supported settings schema before ANY disk change.
class CellSettingsReceiver {
  constructor(filePath, { controllerKey, cellKey, validate = validateCellSettings, apply, authority = async () => null }) {
    if (typeof validate !== 'function' || typeof apply !== 'function') throw new TypeError('Settings adapters required');
    this.filePath = path.resolve(filePath);
    this.trust = Object.freeze({ controllerKey, cellKey });
    this.validate = validate;
    this.apply = apply;
    this.authority = authority;
  }

  async load() {
    let raw;
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) {
        throw new Error('Invalid settings file');
      }
      if (process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
        throw new Error('Unsafe settings file ownership or permissions');
      }
      const directory = await fs.lstat(path.dirname(this.filePath));
      if (!directory.isDirectory() || (process.platform !== 'win32'
        && (directory.uid !== process.getuid() || (directory.mode & 0o077)))) {
        throw new Error('Private cell settings directory required');
      }
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || !validEpochJournal(state) || !state.received || (state.applied !== null
        && (typeof state.applied !== 'object' || Array.isArray(state.applied)))) {
      throw new Error('Invalid settings state');
    }
    verifySettings(state.received, this.trust);
    if (state.applied) {
      verifySettings(state.applied, this.trust);
      if ((state.appliedGeneration ?? 0) === (state.receivedGeneration ?? 0)
        && (state.applied.revision > state.received.revision
        || (state.applied.revision === state.received.revision
          && state.applied.payload !== state.received.payload))) throw new Error('Invalid applied settings state');
    }
    return state;
  }

  async save(state) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const dirStat = await fs.lstat(dir);
    if (!dirStat.isDirectory() || (process.platform !== 'win32'
      && (dirStat.uid !== process.getuid() || (dirStat.mode & 0o077)))) {
      throw new Error('Private cell settings directory required');
    }
    const temporary = path.join(dir, `.cell-settings-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(dir, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  exclusive(work) {
    const task = (queues.get(this.filePath) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.filePath, task);
    const cleanup = () => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); };
    task.then(cleanup, cleanup);
    return task;
  }

  receive(input) {
    const envelope = structuredClone(input);
    return this.exclusive(async () => {
      const { settings, hash } = verifySettings(envelope, this.trust);
      const validated = await this.validate(settings);
      const state = await this.load();
      const authority = await this.authority();
      if (state && sameEpoch(state, authority)) {
        if (envelope.revision < state.received.revision) throw new Error('Stale settings revision');
        if (envelope.revision === state.received.revision
          && hash !== verifySettings(state.received, this.trust).hash) throw new Error('Conflicting settings revision');
        if (envelope.revision === state.applied?.revision && sameEpoch(state, authority, true)) {
          return { received: envelope.revision, applied: envelope.revision };
        }
      }
      // Only a reply verified under the pinned live authority reaches receive().
      // Its first revision starts a new monotonic epoch after explicit takeover.
      // Keep the old applied envelope until the replacement actually succeeds.
      const next = receivingState(state, envelope, authority);
      await this.save(next);
      await this.apply(validated === undefined ? settings : validated);
      await this.save(appliedState(next, envelope, authority));
      return { received: envelope.revision, applied: envelope.revision };
    });
  }

  // Startup restores only the last confirmed applied version, never a failed new one.
  restoreApplied() {
    return this.exclusive(async () => {
      const state = await this.load();
      if (!state?.applied) return { applied: null };
      const { settings } = verifySettings(state.applied, this.trust);
      const validated = await this.validate(settings);
      await this.apply(validated === undefined ? settings : validated);
      return { applied: state.applied.revision };
    });
  }
}

module.exports = { CellSettingsReceiver };
