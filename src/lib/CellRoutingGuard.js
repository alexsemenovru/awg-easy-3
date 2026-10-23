'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runProcess } = require('./ProcessRunner');
const { runNftBatch } = require('./NftBatchRunner');
const { routingGuardSnapshot, nftFingerprint, planNftReplacement, dataTable } = require('./CellNftOwnership');
const DEFAULT_TABLE = 'awg_easy_3_routing_guard';
const queues = new Map();
const snapshot = (names, table) => names.length ? routingGuardSnapshot(names, table) : null;
const equal = (a, b, table) => a === null || b === null ? a === b
  : nftFingerprint(a, table) === nftFingerprint(b, table);
function names(value) {
  if (!Array.isArray(value)) throw new TypeError('Invalid guard interfaces');
  if (value.length) routingGuardSnapshot(value);
  return [...value].sort();
}
function validate(value) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'interfaces,pending,version') throw new Error('Invalid guard journal');
  names(value.interfaces);
  if (value.pending !== null) {
    const p = value.pending;
    if (!p || !['protect', 'release'].includes(p.kind)) throw new Error('Invalid guard intent');
    if (p.kind === 'release') {
      if (Object.keys(p).join(',') !== 'kind' || !value.interfaces.length) throw new Error('Invalid guard release');
    } else {
      if (Object.keys(p).sort().join(',') !== 'interfaces,kind' || !names(p.interfaces).length
        || value.interfaces.some(n => !p.interfaces.includes(n))) throw new Error('Invalid guard protection');
    }
  }
  return value;
}

// Durable guard only, NOT the whole topology transaction. The caller must own
// the runtime exclusively (one process) and verify AWG/routes/policy before
// release. Startup recovery must run before accepting work. Never infer table
// ownership from its name, and never shrink protection during a transaction.
class CellRoutingGuard {
  constructor({ journalPath, runner = runProcess, table = DEFAULT_TABLE }) {
    if (typeof journalPath !== 'string' || !journalPath
      || !(['awg_easy_3_routing_guard', 'awg_easy_3_bootstrap_guard',
        'awg_easy_3_control_guard', 'awg_easy_3_cell_guard'].includes(table)
        || dataTable(table, true))) {
      throw new TypeError('Guard journal and owned table required');
    }
    this.file = path.resolve(journalPath); this.runner = runner; this.table = table;
  }
  snapshot(names) { return snapshot(names, this.table); }
  equal(a, b) { return equal(a, b, this.table); }
  exclusive(work) {
    const task = (queues.get(this.file) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.file, task);
    const clear = () => { if (queues.get(this.file) === task) queues.delete(this.file); };
    task.then(clear, clear); return task;
  }
  async load() {
    try {
      const info = await fs.lstat(this.file);
      if (!info.isFile() || info.nlink !== 1 || info.size > 65536
        || (process.platform !== 'win32'
          && (info.uid !== process.getuid() || (info.mode & 0o077)))) {
        throw new Error('Unsafe guard journal');
      }
      return validate(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, interfaces: [], pending: null };
      throw error;
    }
  }
  async save(value) {
    const data = JSON.stringify(validate(value)), directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const dirInfo = await fs.lstat(directory);
    if (!dirInfo.isDirectory() || (process.platform !== 'win32'
      && (dirInfo.uid !== process.getuid() || (dirInfo.mode & 0o077)))) {
      throw new Error('Private guard journal directory required');
    }
    const temporary = path.join(directory, `.guard-${crypto.randomUUID()}.tmp`);
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
    // List first: a permission/transport error must not be confused with absence.
    const tables = JSON.parse((await this.runner('nft', ['-j', 'list', 'tables'])).stdout);
    if (!tables || !Array.isArray(tables.nftables)) throw new Error('Invalid nft inventory');
    if (tables.nftables.some(x => !x || typeof x !== 'object' || Object.keys(x).length !== 1
      || (!Object.hasOwn(x, 'metainfo') && (!x.table || typeof x.table.family !== 'string' || typeof x.table.name !== 'string')))) {
      throw new Error('Invalid nft inventory');
    }
    if (!tables.nftables.some(x => x.table?.family === 'inet' && x.table.name === this.table)) return null;
    return JSON.parse((await this.runner('nft', ['-j', 'list', 'table', 'inet', this.table])).stdout);
  }
  candidates(saved) {
    return [this.snapshot(saved.interfaces), ...(saved.pending?.kind === 'protect'
      ? [this.snapshot(saved.pending.interfaces)] : [])];
  }
  async plan(candidates, desired) {
    const current = await this.current();
    const owned = current === null ? null : candidates.find(candidate => this.equal(candidate, current));
    if (current !== null && !owned) throw new Error('Foreign or changed routing guard; refusing mutation');
    return planNftReplacement({ table: this.table, current, owned, desired });
  }
  async change(candidates, desired) {
    const plan = await this.plan(candidates, desired);
    if (plan.changed) {
      const input = JSON.stringify(plan.batch);
      await runNftBatch(this.runner, input, path.dirname(this.file));
    }
    if (!this.equal(await this.current(), desired)) throw new Error('Routing guard verification failed');
  }
  protect(interfaces) {
    const requested = names(interfaces);
    if (!requested.length) throw new TypeError('Protection requires interfaces');
    return this.exclusive(async () => {
      const saved = await this.load();
      if (saved.pending) throw new Error('Interrupted guard operation requires recovery');
      const combined = names([...new Set([...saved.interfaces, ...requested])]);
      const desired = this.snapshot(combined);
      await this.plan(this.candidates(saved), desired);
      const intent = { ...saved, pending: { kind: 'protect', interfaces: combined } };
      await this.save(intent); // exact before/after ownership durable BEFORE nft
      await this.change(this.candidates(intent), desired);
      await this.save({ version: 1, interfaces: combined, pending: null });
      return { guarded: true, interfaces: combined };
    });
  }
  async restore(saved) {
    // Interrupted release is cancelled, not completed: uncertainty means block.
    const protectedNames = saved.pending?.kind === 'protect' ? saved.pending.interfaces : saved.interfaces;
    await this.change(this.candidates(saved), this.snapshot(protectedNames));
    await this.save({ version: 1, interfaces: protectedNames, pending: null });
    return { guarded: protectedNames.length > 0, interfaces: [...protectedNames] };
  }
  recover() { return this.exclusive(async () => this.restore(await this.load())); }
  release(verifyRuntime) {
    if (typeof verifyRuntime !== 'function') throw new TypeError('Runtime verification required');
    return this.exclusive(async () => {
      const saved = await this.load();
      if (saved.pending) throw new Error('Interrupted guard operation requires recovery');
      if (!saved.interfaces.length) throw new Error('No active owned guard');
      // Restore a missing guard before the coordinator verifies the runtime.
      await this.change(this.candidates(saved), this.snapshot(saved.interfaces));
      if (await verifyRuntime() !== true) throw new Error('Runtime not verified; guard retained');
      const intent = { ...saved, pending: { kind: 'release' } };
      await this.save(intent);
      try {
        await this.change(this.candidates(intent), null);
        await this.save({ version: 1, interfaces: [], pending: null });
      } catch (error) {
        try { await this.restore(intent); } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], 'Guard release failed; recovery required');
        }
        throw error;
      }
      return { guarded: false };
    });
  }
}
module.exports = { CellRoutingGuard };
