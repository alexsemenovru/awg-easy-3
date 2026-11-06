'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { CellAwgLifecycle, specification: deviceSpec } = require('./CellAwgLifecycle');
const { CellAwgTransaction } = require('./CellAwgTransaction');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { CellRoutingCoordinator, specification: routingSpec } = require('./CellRoutingCoordinator');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const queues = new Map();
function specification(value) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'devices,routing,version'
    || !Array.isArray(value.devices) || !value.devices.length) throw new TypeError('Invalid network specification');
  const devices = value.devices.map(deviceSpec).sort((a, b) => a.owner.interfaceName.localeCompare(b.owner.interfaceName));
  const names = devices.map(d => d.owner.interfaceName), routing = routingSpec(value.routing);
  if (new Set(names).size !== names.length || !equal([...names].sort(), routing.interfaces)) throw new TypeError('Network interface mismatch');
  return { version: 1, devices, routing };
}
function membershipPlan(before, after) {
  before = specification(before); after = specification(after);
  const oldDevices = new Map(before.devices.map(device => [device.owner.interfaceName, device]));
  const newDevices = new Map(after.devices.map(device => [device.owner.interfaceName, device]));
  const identity = device => ({ ...device, owner: { ...device.owner,
    config: normalizeAwgConfig(device.owner.config).interface.privatekey } });
  const added = [], removed = [], retained = [];
  for (const [name, device] of newDevices) {
    const previous = oldDevices.get(name);
    if (!previous) added.push(name);
    else {
      if (!equal(identity(previous), identity(device))) throw new Error('Network device identity/address changes require lifecycle transition');
      retained.push(name);
    }
  }
  for (const name of oldDevices.keys()) if (!newDevices.has(name)) removed.push(name);
  return Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed), retained: Object.freeze(retained),
    protectedInterfaces: Object.freeze([...new Set([...oldDevices.keys(), ...newDevices.keys()])].sort()) });
}
function compatible(before, after) {
  const plan = membershipPlan(before, after);
  if (plan.added.length || plan.removed.length) throw new Error('Network device membership changes require lifecycle transition');
}
function validate(value) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'committed,pending,version') throw new Error('Invalid network journal');
  const committed = value.committed === null ? null : specification(value.committed);
  let pending = null;
  if (value.pending !== null) {
    if (!committed || !value.pending || Object.keys(value.pending).join(',') !== 'desired') throw new Error('Invalid network intent');
    pending = { desired: specification(value.pending.desired) }; compatible(committed, pending.desired);
  }
  return { version: 1, committed, pending };
}
// Coordinates configuration changes on an EXISTING fixed device set. Provision
// with lifecycle first. Caller holds an external process lock. No device rekey,
// membership/address changes. Recovery may reconstruct missing owned devices
// from the parent's authorized lifecycle snapshots while the guard is active.
class CellNetworkTransaction {
  constructor({ directory, runner, components }) {
    this.directory = path.resolve(directory); this.file = path.join(this.directory, 'network.json');
    this.runner = runner; this.components = components; this.expected = null;
    this.routing = components?.routing || new CellRoutingCoordinator({ directory: this.directory, runner,
      verifyInterfaces: async names => this.expected !== null && equal([...names].sort(), this.expected.routing.interfaces)
        && await this.verifyDevices(this.expected) });
    this.guard = this.routing.guard;
  }
  device(name) { return this.components?.device(name) || new CellAwgLifecycle({
    journalPath: path.join(this.directory, `device-${name}.json`), runner: this.runner,
    activateGuard: () => {
      if (!this.expected) throw new Error('Network recovery specification required');
      return this.protect(this.expected);
    },
  }); }
  awg(name) { return this.components?.awg(name) || new CellAwgTransaction({
    journalPath: path.join(this.directory, `unused-awg-${name}.json`), runner: this.runner,
    activateGuard: () => { throw new Error('Use network journal'); },
  }); }
  exclusive(work) {
    const task = (queues.get(this.file) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.file, task);
    const clear = () => { if (queues.get(this.file) === task) queues.delete(this.file); };
    task.then(clear, clear); return task;
  }
  async load() {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 96 * 1024 * 1024
        || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error('Unsafe network journal');
      let value;
      try { value = parseStateText(await fs.readFile(this.file, 'utf8')); } catch { throw new Error('Unreadable private network journal'); }
      return validate(value);
    } catch (e) { if (e.code === 'ENOENT') return { version: 1, committed: null, pending: null }; throw e; }
  }
  async save(value) {
    const data = JSON.stringify(validate(value));
    if (Buffer.byteLength(data) > 96 * 1024 * 1024) throw new Error('Network journal too large');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error('Private network directory required');
    const file = path.join(this.directory, `.network-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(encodeStateText(data, this.file)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(file, this.file);
      if (process.platform !== 'win32') {
        const parent = await fs.open(this.directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async protect(spec) {
    const state = await this.guard.load();
    const names = state.pending?.kind === 'protect' ? state.pending.interfaces : state.interfaces;
    if (names.some(name => !spec.routing.interfaces.includes(name))) throw new Error('Unrelated protection cannot be replaced');
    await this.guard.recover(); await this.guard.protect(spec.routing.interfaces);
  }
  async verifyDevices(spec) {
    for (const device of spec.devices) {
      const life = this.device(device.owner.interfaceName), saved = await life.load();
      if (saved.phase !== 'ready' || !equal(saved.spec, device) || !(await life.verify(device)).up) return false;
    }
    return true;
  }
  async verify(spec) {
    this.expected = spec;
    const child = await this.routing.load();
    return !child.pending && equal(child.committed, spec.routing)
      && await this.verifyDevices(spec) && await this.routing.verify(spec.routing);
  }
  async checkChildren(candidates, recovering = false) {
    const routing = await this.routing.load();
    if (!candidates.some(s => equal(s.routing, routing.committed))
      || (routing.pending && !candidates.some(s => equal(s.routing, routing.pending.desired)))) throw new Error('Unrelated routing journal');
    for (let index = 0; index < candidates[0].devices.length; index++) {
      const choices = candidates.map(s => s.devices[index]);
      const saved = await this.device(choices[0].owner.interfaceName).load();
      if (!['ready', ...(recovering ? ['creating'] : [])].includes(saved.phase)
        || !choices.some(d => equal(d, saved.spec))) throw new Error('Unrelated lifecycle journal');
    }
  }
  async reconcile(candidates, desired, recovering) {
    await this.checkChildren(candidates, recovering);
    this.expected = desired;
    for (let index = 0; index < desired.devices.length; index++) {
      const device = desired.devices[index], life = this.device(device.owner.interfaceName);
      if (recovering && ((await life.load()).phase === 'creating' || !await life.link(device.owner.interfaceName))) {
        // Resume only a journaled creation or reconstruct a genuinely missing
        // device. Existing same-name foreign/untagged devices remain refused.
        await life.recover();
      }
      // The parent intent is durable before any setconf. Only its exact before/
      // after snapshots authorize a change; unrelated drift remains blocked.
      await this.awg(device.owner.interfaceName).reconcile(candidates.map(s => s.devices[index].owner), device.owner);
      const state = await life.verify(device, recovering);
      if (!recovering && !state.up) throw new Error('Network device not ready');
      await life.save({ version: 1, phase: 'ready', spec: device, blankHash: null });
      if (recovering) await life.recover();
      if (!(await life.verify(device)).up) throw new Error('Recovered network device not ready');
    }
    this.expected = desired;
    if (recovering) await this.routing.recover();
    await this.routing.apply(desired.routing, { retainGuard: true });
    if (!await this.verify(desired)) throw new Error('Network readback failed');
  }
  initialize(value) {
    const desired = specification(value);
    return this.exclusive(async () => {
      const saved = await this.load();
      if (saved.committed || saved.pending) throw new Error('Network already initialized');
      if (!await this.verify(desired)) throw new Error('Provisioned network not verified');
      await this.protect(desired);
      if (!await this.verify(desired)) throw new Error('Provisioned network not verified');
      await this.save({ version: 1, committed: desired, pending: null });
      return { initialized: true, guarded: true };
    });
  }
  async restore(saved) {
    const candidates = [saved.committed, ...(saved.pending ? [saved.pending.desired] : [])];
    await this.reconcile(candidates, saved.committed, true);
    await this.save({ version: 1, committed: saved.committed, pending: null });
    return { restored: true, guarded: true };
  }
  apply(value) {
    const desired = specification(value);
    return this.exclusive(async () => {
      const saved = await this.load();
      if (!saved.committed || saved.pending) throw new Error('Network initialization or recovery required');
      compatible(saved.committed, desired); await this.protect(saved.committed);
      if (!await this.verify(saved.committed)) throw new Error('Committed network drifted');
      const intent = { ...saved, pending: { desired } }; await this.save(intent);
      try {
        await this.reconcile([saved.committed, desired], desired, false);
        await this.save({ version: 1, committed: desired, pending: null });
      } catch {
        try { await this.restore(intent); } catch { throw new Error('Network rollback refused or failed; guard and intent retained'); }
        throw new Error('Network update failed; previous version restored under guard');
      }
      await this.guard.release(() => this.verify(desired));
      return { applied: true, guarded: false };
    });
  }
  recover() {
    return this.exclusive(async () => {
      const saved = await this.load();
      if (!saved.committed) throw new Error('No network commitment to recover');
      await this.protect(saved.committed); return this.restore(saved);
    });
  }
}
module.exports = { CellNetworkTransaction, specification, membershipPlan };
