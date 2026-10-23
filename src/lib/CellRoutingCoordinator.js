'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { CellRoutingGuard } = require('./CellRoutingGuard');
const { CellRouteTransaction } = require('./CellRouteTransaction');
const { CellNftTransaction } = require('./CellNftTransaction');
const { manifest, planRouteChanges } = require('./CellRouteOwnership');
const { routingGuardSnapshot, normalizeNftSnapshot } = require('./CellNftOwnership');
const queues = new Map();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MAX_BYTES = 80 * 1024 * 1024;
function specification(value) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'commands,interfaces,nftSnapshot,version') throw new TypeError('Invalid routing specification');
  routingGuardSnapshot(value.interfaces);
  const interfaces = [...value.interfaces].sort(), routes = manifest(value.commands);
  for (const { record } of routes) for (const key of ['dev', 'iif']) {
    if (record[key] && !interfaces.includes(record[key])) throw new TypeError('Route references unmanaged interface');
  }
  return { version: 1, interfaces, commands: routes.map(x => x.command),
    nftSnapshot: normalizeNftSnapshot(value.nftSnapshot, 'awg_easy_3_routes') };
}
function validate(saved) {
  if (!saved || saved.version !== 1 || Object.keys(saved).sort().join(',') !== 'committed,pending,version') throw new Error('Invalid routing coordinator journal');
  const committed = saved.committed === null ? null : specification(saved.committed);
  let pending = null;
  if (saved.pending !== null) {
    if (!saved.pending || Object.keys(saved.pending).join(',') !== 'desired') throw new Error('Invalid routing coordinator intent');
    pending = { desired: specification(saved.pending.desired) };
    if (committed && !equal(committed.interfaces, pending.desired.interfaces)) throw new Error('Interface membership requires AWG lifecycle coordinator');
  }
  return { version: 1, committed, pending };
}

// Coherent routes+firewall updates for an EXISTING, FIXED set of owned AWG
// interfaces. Does not create/remove/rekey interfaces or provide a process lock.
// verifyInterfaces must check actual ownership/configuration, not only names.
class CellRoutingCoordinator {
  constructor({ directory, verifyInterfaces, runner, components }) {
    if (typeof directory !== 'string' || !directory || typeof verifyInterfaces !== 'function') throw new TypeError('Coordinator directory and interface verifier required');
    this.directory = path.resolve(directory); this.file = path.join(this.directory, 'routing.json');
    this.verifyInterfaces = verifyInterfaces;
    this.guard = components?.guard || new CellRoutingGuard({ journalPath: path.join(this.directory, 'guard.json'), runner });
    // All child operations execute under the coordinator's durable guard.
    const activateGuard = async () => {
      const state = await this.guard.load();
      if (state.pending || !state.interfaces.length) throw new Error('Coordinator guard is not ready');
      await this.guard.protect(state.interfaces);
    };
    this.routes = components?.routes || new CellRouteTransaction({ journalPath: path.join(this.directory, 'routes.json'), activateGuard, runner });
    this.policy = components?.policy || new CellNftTransaction({ journalPath: path.join(this.directory, 'policy.json'), activateGuard, runner });
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
      if (!stat.isFile() || stat.size > MAX_BYTES || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Unsafe routing coordinator journal');
      return validate(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, committed: null, pending: null };
      throw error;
    }
  }
  async save(saved) {
    const data = JSON.stringify(validate(saved));
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Routing coordinator journal too large');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.coordinator-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.file);
      if (process.platform !== 'win32') {
        const parent = await fs.open(this.directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async protect(interfaces) {
    if (await this.verifyInterfaces([...interfaces]) !== true) throw new Error('Owned AWG interfaces not verified');
    const guardState = await this.guard.load();
    const protectedNames = guardState.pending?.kind === 'protect' ? guardState.pending.interfaces : guardState.interfaces;
    if (protectedNames.some(name => !interfaces.includes(name))) throw new Error('Existing protection requires AWG lifecycle coordinator');
    await this.guard.recover();
    await this.guard.protect(interfaces);
  }
  async checkChildren(saved) {
    // A child may have committed before a crash of its parent. Only exact
    // parent-before/parent-after states are allowed, never an unrelated journal.
    const candidates = [saved.committed, ...(saved.pending ? [saved.pending.desired] : [])];
    for (const [child, field, empty] of [[this.routes, 'commands', []], [this.policy, 'nftSnapshot', null]]) {
      const state = await child.load(), allowed = candidates.map(x => x ? x[field] : empty);
      if (!allowed.some(x => equal(x, state.committed))
        || (state.pending && !allowed.some(x => equal(x, state.pending.desired)))) throw new Error('Child journal disagrees with routing coordinator');
    }
  }
  async verify(desired) {
    if (!desired || await this.verifyInterfaces([...desired.interfaces]) !== true) return false;
    const routeState = await this.routes.load(), policyState = await this.policy.load();
    if (routeState.pending || policyState.pending || !equal(routeState.committed, desired.commands)
      || !equal(policyState.committed, desired.nftSnapshot)) return false;
    const routes = planRouteChanges({ previous: desired.commands, desired: desired.commands, inventory: await this.routes.inventory() });
    if (routes.add.length || routes.remove.length) return false;
    return !(await this.policy.plan([desired.nftSnapshot], desired.nftSnapshot)).changed;
  }
  async verifyOperational(value) {
    const desired = specification(value), saved = await this.load();
    if (saved.pending || !saved.committed || !equal(saved.committed, desired)) return false;
    const guard = await this.guard.load();
    if (guard.pending || !Array.isArray(guard.interfaces) || guard.interfaces.length
      || await this.guard.current() !== null) return false;
    return this.verify(desired);
  }
  async restore(saved) {
    await this.checkChildren(saved);
    await this.routes.recover(); await this.policy.recover();
    await this.policy.apply(saved.committed?.nftSnapshot ?? null);
    await this.routes.apply(saved.committed?.commands ?? []);
    if (saved.committed && !await this.verify(saved.committed)) throw new Error('Restored routing state did not verify');
    await this.save({ ...saved, pending: null });
    // Deliberately retain the guard after recovery/rollback. Explicit apply of
    // the confirmed specification is required before enabling traffic again.
    return { restored: saved.committed !== null, guarded: true };
  }
  apply(value, { retainGuard = false } = {}) {
    if (typeof retainGuard !== 'boolean') throw new TypeError('Invalid guard retention option');
    const desired = specification(value);
    return this.exclusive(async () => {
      const saved = await this.load();
      if (saved.pending) throw new Error('Interrupted coordinated routing requires recovery');
      if (saved.committed && !equal(saved.committed.interfaces, desired.interfaces)) throw new Error('Interface membership requires AWG lifecycle coordinator');
      await this.protect(desired.interfaces);
      await this.checkChildren(saved);
      const intent = { ...saved, pending: { desired } };
      await this.save(intent);
      try {
        await this.policy.apply(desired.nftSnapshot);
        await this.routes.apply(desired.commands);
        if (!await this.verify(desired)) throw new Error('Routing specification did not verify');
        await this.save({ version: 1, committed: desired, pending: null });
      } catch (error) {
        try { await this.restore(intent); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Coordinated routing rollback failed; guard retained'); }
        throw error;
      }
      // Parent commitment precedes release. A release error must not roll back
      // the committed parent state, and guard.release handles its own recovery.
      if (!retainGuard) await this.guard.release(() => this.verify(desired));
      return { applied: true, guarded: retainGuard };
    });
  }
  releaseCommitted() {
    return this.exclusive(async () => {
      const saved = await this.load();
      if (saved.pending || !saved.committed) {
        throw new Error('No committed routing specification to release');
      }
      await this.protect(saved.committed.interfaces);
      await this.checkChildren(saved);
      await this.guard.release(() => this.verify(saved.committed));
      return { guarded: false };
    });
  }
  recover() {
    return this.exclusive(async () => {
      const saved = await this.load(), desired = saved.pending?.desired || saved.committed;
      if (!desired) {
        await this.checkChildren(saved);
        return { restored: false, ...(await this.guard.recover()) };
      }
      await this.protect(desired.interfaces);
      return this.restore(saved);
    });
  }
}
module.exports = { CellRoutingCoordinator, specification };
