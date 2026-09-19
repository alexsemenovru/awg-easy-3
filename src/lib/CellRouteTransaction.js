'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runProcess } = require('./ProcessRunner');
const { manifest, planRouteChanges } = require('./CellRouteOwnership');
const queues = new Map();
const MAX_BYTES = 8 * 1024 * 1024;
function union(a, b) {
  const map = new Map(manifest([...a]).map(x => [JSON.stringify(x.record), x.command]));
  for (const x of manifest(b)) map.set(JSON.stringify(x.record), x.command);
  return [...map.values()];
}
function state(value) {
  if (!value || value.version !== 1 || Object.keys(value).some(k => !['version', 'committed', 'pending'].includes(k))) throw new Error('Invalid route journal');
  manifest(value.committed);
  if (value.pending !== null) {
    if (!value.pending || Object.keys(value.pending).join(',') !== 'desired') throw new Error('Invalid pending routes');
    manifest(value.pending.desired);
  }
  return value;
}

// Route-only building block. The topology coordinator owns AWG and nft policy.
// activateGuard MUST durably block all affected interfaces, including removed
// ones, before resolving. This component NEVER releases that guard, even on
// success: only the coordinator may release it after verifying the whole VPN.
// One owning process per journal (same-process instances are serialized).
class CellRouteTransaction {
  constructor({ journalPath, activateGuard, runner = runProcess }) {
    if (typeof journalPath !== 'string' || !journalPath || typeof activateGuard !== 'function') throw new TypeError('Journal and guard required');
    this.file = path.resolve(journalPath);
    this.activateGuard = activateGuard;
    this.runner = runner;
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
      if (!stat.isFile() || stat.size > MAX_BYTES || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Unsafe route journal');
      return state(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, committed: [], pending: null };
      throw error;
    }
  }
  async save(value) {
    const data = JSON.stringify(state(value));
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Route journal too large');
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.routes-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.file);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async inventory() {
    const result = {};
    for (const family of [4, 6]) {
      for (const [key, args] of [['routes', ['route', 'show', 'table', 'all']], ['rules', ['rule', 'show']]]) {
        const output = await this.runner('ip', [`-${family}`, '-j', ...args]);
        const parsed = JSON.parse(output.stdout);
        if (!Array.isArray(parsed)) throw new Error('Invalid kernel route inventory');
        result[`${key}${family}`] = parsed;
      }
    }
    return result;
  }
  async reconcile(previous, desired) {
    const plan = planRouteChanges({ previous, desired, inventory: await this.inventory() });
    for (const command of [...plan.remove, ...plan.add]) await this.runner(command.file, command.args);
    const verification = planRouteChanges({ previous: union(previous, desired), desired, inventory: await this.inventory() });
    if (verification.add.length || verification.remove.length) throw new Error('Kernel routes did not converge');
    return { added: plan.add.length, removed: plan.remove.length };
  }
  apply(commands) {
    // Snapshot caller data before async queueing; validate even for no-op calls.
    const desired = manifest(commands).map(x => x.command);
    return this.exclusive(async () => {
      const saved = await this.load();
      if (saved.pending) throw new Error('Interrupted route transaction requires recovery');
      planRouteChanges({ previous: saved.committed, desired, inventory: await this.inventory() });
      await this.activateGuard({ previous: saved.committed, desired });
      await this.save({ ...saved, pending: { desired } });
      try {
        const changes = await this.reconcile(saved.committed, desired);
        await this.save({ version: 1, committed: desired, pending: null });
        return { ...changes, guarded: true };
      } catch (error) {
        // The durable pending record authorizes only exact before/after objects.
        // Foreign/drifted objects stop recovery; they are never overwritten.
        try {
          await this.reconcile(union(saved.committed, desired), saved.committed);
          await this.save(saved);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Route apply and rollback failed; guard retained, recovery required');
        }
        throw error;
      }
    });
  }
  recover() {
    return this.exclusive(async () => {
      const saved = await this.load();
      const possible = saved.pending ? union(saved.committed, saved.pending.desired) : saved.committed;
      await this.activateGuard({ previous: possible, desired: saved.committed });
      const changes = await this.reconcile(possible, saved.committed);
      await this.save({ ...saved, pending: null });
      return { ...changes, guarded: true };
    });
  }
}
module.exports = { CellRouteTransaction };
