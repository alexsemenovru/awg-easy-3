'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { signSettings, verifySettings } = require('./CellSettings');
const { verifySettingsAck } = require('./CellSettingsAck');
const { validateCellSettings } = require('./CellSettingsSchema');
const queues = new Map();

// One file per cell; path is chosen by the local service, never remote input.
class CellSettingsPublisher {
  constructor(filePath, identityStore, cellKey) {
    this.filePath = path.resolve(filePath);
    this.identityStore = identityStore;
    this.cellKey = cellKey;
  }

  async load() {
    let raw;
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) {
        throw new Error('Invalid published settings file');
      }
      if (process.platform !== 'win32'
        && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
        throw new Error('Unsafe published settings owner or permissions');
      }
      const directory = await fs.lstat(path.dirname(this.filePath));
      if (!directory.isDirectory() || (process.platform !== 'win32'
        && (directory.uid !== process.getuid() || (directory.mode & 0o077)))) {
        throw new Error('Private published settings directory required');
      }
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const state = parseStateText(raw);
    const controller = await this.identityStore.load('controller');
    if (!state || state.version !== 1 || !state.desired
      || !['ack,desired,version', 'ack,confirmed,desired,version'].includes(
        Object.keys(state).sort().join(','))
      || (state.ack !== null && (typeof state.ack !== 'object' || Array.isArray(state.ack)))) {
      throw new Error('Invalid published settings state');
    }
    const result = verifySettings(state.desired, { controllerKey: controller.publicKey, cellKey: this.cellKey });
    validateCellSettings(result.settings);
    if (state.ack) verifySettingsAck(state.ack, state.desired);
    // Older journals had only desired+ack. Preserve their confirmed revision
    // when the next desired revision is first published after an upgrade.
    const confirmed = state.confirmed === undefined
      ? (state.ack ? { desired: state.desired, ack: state.ack } : null)
      : state.confirmed;
    if (confirmed !== null) {
      if (!confirmed || Object.keys(confirmed).sort().join(',') !== 'ack,desired') {
        throw new Error('Invalid confirmed cell settings state');
      }
      const last = verifySettings(confirmed.desired,
        { controllerKey: controller.publicKey, cellKey: this.cellKey });
      validateCellSettings(last.settings);
      verifySettingsAck(confirmed.ack, confirmed.desired);
      if (confirmed.desired.revision > state.desired.revision
        || (confirmed.desired.revision === state.desired.revision
          && (confirmed.desired.payload !== state.desired.payload
            || state.ack === null))) {
        throw new Error('Confirmed cell settings differ from desired revision');
      }
    }
    if (state.ack && (!confirmed
      || JSON.stringify(confirmed.desired) !== JSON.stringify(state.desired)
      || JSON.stringify(confirmed.ack) !== JSON.stringify(state.ack))) {
      throw new Error('Confirmed cell settings disagree with acknowledgement');
    }
    return { ...state, confirmed };
  }

  async status() {
    const state = await this.load();
    const desiredRevision = state?.desired.revision ?? null;
    const confirmedRevision = state?.confirmed?.desired.revision ?? null;
    return Object.freeze({ desiredRevision, confirmedRevision,
      awaitingAck: desiredRevision !== null && desiredRevision !== confirmedRevision });
  }

  async save(state) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const dirStat = await fs.lstat(dir);
    if (!dirStat.isDirectory() || (process.platform !== 'win32'
      && (dirStat.uid !== process.getuid() || (dirStat.mode & 0o077)))) {
      throw new Error('Private published settings directory required');
    }
    const temporary = path.join(dir, `.settings-publisher-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(encodeStateText(JSON.stringify(state), this.filePath), 'utf8');
      await handle.sync(); await handle.close(); handle = undefined;
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
    const done = () => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); };
    task.then(done, done);
    return task;
  }

  publish(input) {
    const settings = validateCellSettings(structuredClone(input));
    return this.exclusive(async () => {
      const previous = await this.load();
      const controller = await this.identityStore.load('controller');
      const desired = signSettings({ cellKey: this.cellKey, revision: (previous?.desired.revision || 0) + 1,
        settings }, controller.privateKey);
      await this.save({ version: 1, desired, ack: null,
        confirmed: previous?.confirmed ?? null });
      return desired;
    });
  }

  acknowledge(input) {
    const ack = structuredClone(input);
    return this.exclusive(async () => {
      const state = await this.load();
      if (!state) throw new Error('No published settings');
      const result = verifySettingsAck(ack, state.desired);
      await this.save({ ...state, ack,
        confirmed: { desired: state.desired, ack } });
      return result;
    });
  }
}

module.exports = { CellSettingsPublisher };
