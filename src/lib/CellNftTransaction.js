'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runProcess } = require('./ProcessRunner');
const { runNftBatch } = require('./NftBatchRunner');
const { normalizeNftSnapshot, nftFingerprint, planNftReplacement } = require('./CellNftOwnership');
const DEFAULT_TABLE = 'awg_easy_3_routes';
const MAX_BYTES = 64 * 1024 * 1024 + 4096;
const queues = new Map();
function validate(value, table) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'committed,pending,version') throw new Error('Invalid nft journal');
  const normalize = input => input === null ? null : normalizeNftSnapshot(input, table);
  normalize(value.committed);
  if (value.pending !== null) {
    if (!value.pending || Object.keys(value.pending).join(',') !== 'desired') throw new Error('Invalid nft intent');
    normalize(value.pending.desired);
  }
  return value;
}
// Firewall-only component. Caller is the sole owning process and must supply a
// durable guard covering old AND new interfaces. Guard is NEVER released here.
// Cross-component crash recovery still belongs to the topology coordinator.
class CellNftTransaction {
  constructor({ journalPath, activateGuard, runner = runProcess, table = DEFAULT_TABLE }) {
    if (typeof journalPath !== 'string' || !journalPath || typeof activateGuard !== 'function') throw new TypeError('Nft journal and guard required');
    // Validate the table even before a journal exists.
    normalizeNftSnapshot({ nftables: [{ table: { family: 'inet', name: table } }] }, table);
    this.file = path.resolve(journalPath); this.runner = runner;
    this.activateGuard = activateGuard; this.table = table;
  }
  normalize(value) { return value === null ? null : normalizeNftSnapshot(value, this.table); }
  equal(a, b) { return a === null || b === null ? a === b
    : nftFingerprint(a, this.table) === nftFingerprint(b, this.table); }
  exclusive(work) {
    const task = (queues.get(this.file) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.file, task);
    const clear = () => { if (queues.get(this.file) === task) queues.delete(this.file); };
    task.then(clear, clear); return task;
  }
  async load() {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.size > MAX_BYTES || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Unsafe nft journal');
      return validate(JSON.parse(await fs.readFile(this.file, 'utf8')), this.table);
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, committed: null, pending: null };
      throw error;
    }
  }
  async save(value) {
    const data = JSON.stringify(validate(value, this.table));
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Nft journal too large');
    const directory = path.dirname(this.file), temporary = path.join(directory, `.nft-${crypto.randomUUID()}.tmp`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
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
  async current() {
    const tables = JSON.parse((await this.runner('nft', ['-j', 'list', 'tables'])).stdout);
    if (!tables || !Array.isArray(tables.nftables) || tables.nftables.some(x => !x || typeof x !== 'object'
      || Object.keys(x).length !== 1 || (!Object.hasOwn(x, 'metainfo') && (!x.table
        || typeof x.table.family !== 'string' || typeof x.table.name !== 'string')))) throw new Error('Invalid nft inventory');
    if (!tables.nftables.some(x => x.table?.family === 'inet' && x.table.name === this.table)) return null;
    return this.normalize(JSON.parse((await this.runner('nft', ['-j', 'list', 'table', 'inet', this.table], { maxOutputBytes: 32 * 1024 * 1024 })).stdout));
  }
  candidates(saved) { return [saved.committed, ...(saved.pending ? [saved.pending.desired] : [])]; }
  async plan(candidates, desired) {
    const current = await this.current();
    const owned = current === null ? null : candidates.find(candidate => this.equal(candidate, current));
    if (current !== null && !owned) throw new Error('Foreign or changed cell policy; refusing mutation');
    return planNftReplacement({ table: this.table, current, owned, desired });
  }
  async reconcile(candidates, desired) {
    const plan = await this.plan(candidates, desired);
    if (plan.changed) {
      const input = JSON.stringify(plan.batch);
      await runNftBatch(this.runner, input, path.dirname(this.file));
    }
    if (!this.equal(await this.current(), desired)) throw new Error('Cell nft policy did not converge');
    return { changed: plan.changed, guarded: true };
  }
  apply(snapshot) {
    const desired = this.normalize(snapshot);
    return this.exclusive(async () => {
      const saved = await this.load();
      if (saved.pending) throw new Error('Interrupted nft transaction requires recovery');
      await this.plan(this.candidates(saved), desired);
      await this.activateGuard({ previous: saved.committed, desired });
      const intent = { ...saved, pending: { desired } };
      await this.save(intent);
      try {
        const changes = await this.reconcile(this.candidates(intent), desired);
        await this.save({ version: 1, committed: desired, pending: null });
        return changes;
      } catch (error) {
        try {
          await this.reconcile(this.candidates(intent), saved.committed);
          await this.save(saved);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Nft apply and rollback failed; guard retained, recovery required');
        }
        throw error;
      }
    });
  }
  recover() {
    return this.exclusive(async () => {
      const saved = await this.load();
      await this.activateGuard({ previous: saved.committed, desired: saved.pending?.desired ?? saved.committed });
      const changes = await this.reconcile(this.candidates(saved), saved.committed);
      await this.save({ ...saved, pending: null });
      return changes;
    });
  }
}
module.exports = { CellNftTransaction };
