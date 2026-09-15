'use strict';
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
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid published settings file');
      if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Published settings permissions too broad');
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const state = JSON.parse(raw);
    const controller = await this.identityStore.load('controller');
    if (state.version !== 1 || !state.desired) throw new Error('Invalid published settings state');
    const result = verifySettings(state.desired, { controllerKey: controller.publicKey, cellKey: this.cellKey });
    validateCellSettings(result.settings);
    if (state.ack) verifySettingsAck(state.ack, state.desired);
    return state;
  }

  async save(state) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.settings-publisher-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state), 'utf8');
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
      await this.save({ version: 1, desired, ack: null });
      return desired;
    });
  }

  acknowledge(input) {
    const ack = structuredClone(input);
    return this.exclusive(async () => {
      const state = await this.load();
      if (!state) throw new Error('No published settings');
      const result = verifySettingsAck(ack, state.desired);
      await this.save({ ...state, ack });
      return result;
    });
  }
}

module.exports = { CellSettingsPublisher };
