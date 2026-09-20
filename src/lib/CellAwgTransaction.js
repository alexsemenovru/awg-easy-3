'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runProcess } = require('./ProcessRunner');
const { validateAwgOwnership, inspectAwgOwnership } = require('./CellAwgOwnership');
const { normalizeAwgConfig, matchesAwgConfig } = require('./CellAwgSnapshot');
const queues = new Map();
const MAX_BYTES = 9 * 1024 * 1024;
function compatible(before, after) {
  const a = validateAwgOwnership(before), b = validateAwgOwnership(after);
  if (a.interfaceName !== b.interfaceName || a.ownerTag !== b.ownerTag || a.mtu !== b.mtu
    || normalizeAwgConfig(a.config).interface.privatekey !== normalizeAwgConfig(b.config).interface.privatekey) {
    throw new Error('AWG identity, interface and MTU changes require lifecycle coordination');
  }
  return b;
}
function validate(value) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'committed,pending,version') throw new Error('Invalid AWG journal');
  if (value.committed !== null) validateAwgOwnership(value.committed);
  if (value.pending !== null) {
    if (!value.committed || !value.pending || Object.keys(value.pending).join(',') !== 'desired') throw new Error('Invalid AWG intent');
    compatible(value.committed, value.pending.desired);
  }
  return value;
}
// Configuration-only transaction for one already-created, explicitly owned AWG
// interface. No adoption, creation/deletion, address changes or guard release.
// Caller owns the runtime exclusively and supplies a durable guard callback.
class CellAwgTransaction {
  constructor({ journalPath, activateGuard, runner = runProcess }) {
    if (typeof journalPath !== 'string' || !journalPath || typeof activateGuard !== 'function') throw new TypeError('AWG journal and guard required');
    this.file = path.resolve(journalPath); this.activateGuard = activateGuard; this.runner = runner;
  }
  exclusive(work) {
    const task = (queues.get(this.file) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.file, task);
    const clear = () => { if (queues.get(this.file) === task) queues.delete(this.file); };
    task.then(clear, clear); return task;
  }
  async load() {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES
        || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error('Unsafe private AWG journal');
      let value;
      try { value = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch { throw new Error('Unreadable or corrupt private AWG journal'); }
      return validate(value);
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, committed: null, pending: null };
      throw error;
    }
  }
  async privateDirectory() {
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || (process.platform !== 'win32'
      && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error('Private AWG directory required');
    return directory;
  }
  async save(value) {
    const data = JSON.stringify(validate(value));
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('AWG journal too large');
    const directory = await this.privateDirectory(), temporary = path.join(directory, `.awg-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.file);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async inspect(candidates) {
    const name = candidates[0].interfaceName;
    let links, config;
    try {
      // Inventory failure is never interpreted as a missing/owned interface.
      links = JSON.parse((await this.runner('ip', ['-d', '-j', 'link', 'show', 'dev', name])).stdout);
      config = (await this.runner('awg', ['showconf', name], { maxOutputBytes: 4 * 1024 * 1024 })).stdout;
    } catch { throw new Error('AWG interface inspection failed'); }
    for (const candidate of candidates) {
      try {
        const result = inspectAwgOwnership({ manifest: candidate, links, actualConfig: config });
        if (result.verified) return { manifest: candidate, up: result.up };
      } catch { /* Try only the explicitly journaled before/after snapshots. */ }
    }
    throw new Error('Foreign, missing or changed AWG interface; refusing mutation');
  }
  async writeConfig(desired) {
    const directory = await this.privateDirectory(), file = path.join(directory, `.awg-config-${crypto.randomUUID()}.conf`);
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(desired.config); await handle.sync(); } finally { await handle.close(); }
      // setconf is not promised to be atomic. Unexpected partial readback is
      // deliberately refused by recovery; never overwrite unexplained drift.
      try { await this.runner('awg', ['setconf', desired.interfaceName, file]); }
      catch { throw new Error('AWG configuration command failed; guard retained'); }
    } finally { await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async reconcile(candidates, desired) {
    const current = await this.inspect(candidates);
    if (!matchesAwgConfig(desired.config, current.manifest.config)
      || !matchesAwgConfig(current.manifest.config, desired.config)) await this.writeConfig(desired);
    await this.inspect([desired]);
  }
  initialize(value) {
    const owner = validateAwgOwnership(value);
    return this.exclusive(async () => {
      const saved = await this.load();
      if (saved.pending || saved.committed) throw new Error('AWG journal already initialized');
      await this.inspect([owner]);
      await this.activateGuard([owner.interfaceName]);
      await this.inspect([owner]);
      await this.save({ version: 1, committed: owner, pending: null });
      return { initialized: true, guarded: true };
    });
  }
  apply(value) {
    const owner = validateAwgOwnership(value);
    return this.exclusive(async () => {
      const saved = await this.load();
      if (!saved.committed) throw new Error('AWG ownership must be initialized explicitly');
      if (saved.pending) throw new Error('Interrupted AWG update requires recovery');
      const desired = compatible(saved.committed, owner);
      await this.activateGuard([desired.interfaceName]);
      await this.inspect([saved.committed]);
      const intent = { ...saved, pending: { desired } };
      await this.save(intent);
      try {
        await this.reconcile([saved.committed, desired], desired);
        await this.save({ version: 1, committed: desired, pending: null });
      } catch {
        // Do not propagate subprocess errors containing private showconf data.
        try { await this.restore(intent); }
        catch { throw new Error('AWG rollback refused or failed; guard and journal retained'); }
        throw new Error('AWG update failed; previous configuration restored under guard');
      }
      return { applied: true, guarded: true };
    });
  }
  async restore(saved) {
    await this.reconcile([saved.committed, ...(saved.pending ? [saved.pending.desired] : [])], saved.committed);
    await this.save({ ...saved, pending: null });
    return { restored: true, guarded: true };
  }
  recover() {
    return this.exclusive(async () => {
      const saved = await this.load();
      if (!saved.committed) throw new Error('No confirmed AWG ownership to recover');
      await this.activateGuard([saved.committed.interfaceName]);
      return this.restore(saved);
    });
  }
}
module.exports = { CellAwgTransaction };
