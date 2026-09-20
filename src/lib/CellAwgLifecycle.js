'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { runProcess } = require('./ProcessRunner');
const { validateAwgOwnership, inspectAwgOwnership } = require('./CellAwgOwnership');
const { matchesAwgConfig } = require('./CellAwgSnapshot');
const { ipNumber } = require('./GeoIpAddress');
const { formatIPv6 } = require('./AddressAllocator');
const queues = new Map();
const hash = text => crypto.createHash('sha256').update(text.trim()).digest('hex');
function address(text) {
  if (typeof text !== 'string') throw new TypeError('Invalid AWG device address');
  const [host, prefix, extra] = text.split('/'), family = net.isIP(host);
  if (!family || host.includes('%') || extra !== undefined || !/^\d+$/.test(prefix)
    || Number(prefix) > (family === 4 ? 32 : 128)) throw new TypeError('Invalid AWG device address');
  return `${family === 6 ? formatIPv6(ipNumber(host)) : host}/${Number(prefix)}`;
}
function specification(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'addresses,owner,version' || value.version !== 1
    || !Array.isArray(value.addresses) || !value.addresses.length || value.addresses.length > 8) throw new TypeError('Invalid AWG lifecycle specification');
  const addresses = value.addresses.map(address).sort();
  if (new Set(addresses).size !== addresses.length) throw new TypeError('Duplicate AWG device address');
  return { version: 1, owner: validateAwgOwnership(value.owner), addresses };
}
function validate(value) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'blankHash,phase,spec,version'
    || !['empty', 'creating', 'ready', 'removing'].includes(value.phase)) throw new Error('Invalid private AWG lifecycle journal');
  if (value.phase === 'empty') {
    if (value.spec !== null || value.blankHash !== null) throw new Error('Invalid empty lifecycle');
  } else {
    specification(value.spec);
    if (value.blankHash !== null && !/^[a-f0-9]{64}$/.test(value.blankHash)) throw new Error('Invalid creation fingerprint');
  }
  return value;
}
const empty = () => ({ version: 1, phase: 'empty', spec: null, blankHash: null });
// One userspace AWG device. The caller supplies an EXCLUSIVE runtime lock and
// durable guard and coordinates routes/nft/config changes. No fallback backend,
// no WAN/sysctl modification, no guard release, no same-name adoption.
class CellAwgLifecycle {
  constructor({ journalPath, activateGuard, runner = runProcess }) {
    if (typeof journalPath !== 'string' || !journalPath || typeof activateGuard !== 'function') throw new TypeError('AWG lifecycle journal and guard required');
    this.file = path.resolve(journalPath); this.activateGuard = activateGuard; this.runner = runner;
  }
  exclusive(work) {
    const task = (queues.get(this.file) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.file, task);
    const clear = () => { if (queues.get(this.file) === task) queues.delete(this.file); };
    task.then(clear, clear); return task;
  }
  async directory() {
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || (process.platform !== 'win32'
      && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error('Private lifecycle directory required');
    return directory;
  }
  async load() {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024
        || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error('Unsafe lifecycle journal');
      let value;
      try { value = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch { throw new Error('Unreadable private lifecycle journal'); }
      return validate(value);
    } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
  }
  async save(value) {
    const text = JSON.stringify(validate(value));
    if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error('Lifecycle journal too large');
    const directory = await this.directory(), file = path.join(directory, `.life-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(file, this.file);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async run(file, args) {
    try { return await this.runner(file, args, { maxOutputBytes: 5 * 1024 * 1024 }); }
    catch { throw new Error('AWG lifecycle command failed; private details withheld'); }
  }
  async link(name) {
    let rows;
    try { rows = JSON.parse((await this.run('ip', ['-d', '-j', 'link', 'show'])).stdout); }
    catch { throw new Error('AWG link inventory unavailable'); }
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r.ifname !== 'string')) throw new Error('Invalid AWG link inventory');
    const selected = rows.filter(r => r.ifname === name);
    if (selected.length > 1) throw new Error('Ambiguous AWG device');
    return selected[0] || null;
  }
  async addresses(spec) {
    let rows;
    try { rows = JSON.parse((await this.run('ip', ['-j', 'address', 'show', 'dev', spec.owner.interfaceName])).stdout); }
    catch { throw new Error('AWG address inventory unavailable'); }
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].ifname !== spec.owner.interfaceName
      || !Array.isArray(rows[0].addr_info)) throw new Error('Invalid AWG address inventory');
    const actual = rows[0].addr_info.filter(a => !(a.family === 'inet6' && a.scope === 'link')).map(a => {
      if (!['inet', 'inet6'].includes(a.family) || net.isIP(a.local) !== (a.family === 'inet' ? 4 : 6)
        || !Number.isInteger(a.prefixlen)) throw new Error('Invalid AWG address');
      return address(`${a.local}/${a.prefixlen}`);
    }).sort();
    if (actual.some(a => !spec.addresses.includes(a)) || new Set(actual).size !== actual.length) throw new Error('Unexpected AWG addresses; refusing mutation');
    return actual;
  }
  async verify(spec, allowIncomplete = false) {
    const link = await this.link(spec.owner.interfaceName);
    if (!link || link.linkinfo?.info_kind !== 'tun' || link.linkinfo?.info_data?.type !== 'tun') throw new Error('Missing or unexpected userspace AWG device');
    const text = (await this.run('awg', ['showconf', spec.owner.interfaceName])).stdout;
    const state = inspectAwgOwnership({ manifest: spec.owner, links: link ? [link] : [], actualConfig: text });
    if (!state.verified) throw new Error('Missing owned AWG device');
    const actual = await this.addresses(spec);
    if (!allowIncomplete && actual.length !== spec.addresses.length) throw new Error('Missing owned AWG addresses');
    return state;
  }
  async configure(spec) {
    const file = path.join(await this.directory(), `.life-config-${crypto.randomUUID()}.conf`);
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(spec.owner.config); await handle.sync(); } finally { await handle.close(); }
      await this.run('awg', ['setconf', spec.owner.interfaceName, file]);
    } finally { await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async finishCreation(saved) {
    const spec = saved.spec, name = spec.owner.interfaceName;
    let link = await this.link(name);
    if (!link) {
      // Intent was persisted before daemon invocation. A crash before alias
      // assignment leaves an unproven device: recovery must refuse it.
      await this.run('amneziawg-go', [name]);
      link = await this.link(name);
      if (!link || link.ifalias || link.linkinfo?.info_kind !== 'tun'
        || link.linkinfo?.info_data?.type !== 'tun' || !Array.isArray(link.flags)
        || link.flags.includes('UP')) throw new Error('Unexpected newly created AWG device');
      const blank = (await this.run('awg', ['showconf', name])).stdout;
      saved = { ...saved, blankHash: hash(blank) }; await this.save(saved);
      await this.run('ip', ['link', 'set', 'dev', name, 'alias', spec.owner.ownerTag, 'mtu', String(spec.owner.mtu)]);
      link = await this.link(name);
    }
    if (link?.ifalias !== spec.owner.ownerTag || link.mtu !== spec.owner.mtu
      || link.linkinfo?.info_kind !== 'tun' || link.linkinfo?.info_data?.type !== 'tun') throw new Error('Foreign or unproven AWG device; manual inspection required');
    const current = (await this.run('awg', ['showconf', name])).stdout;
    let configured = false;
    try { configured = matchesAwgConfig(spec.owner.config, current); } catch { /* Fresh device has no private key yet. */ }
    if (!configured) {
      if (!saved.blankHash || hash(current) !== saved.blankHash) throw new Error('Unexpected partial AWG configuration; guard retained');
      await this.configure(spec);
    }
    await this.verify(spec, true);
    const actual = await this.addresses(spec);
    for (const cidr of spec.addresses.filter(a => !actual.includes(a))) {
      await this.run('ip', ['address', 'add', cidr, 'dev', name]);
    }
    await this.run('ip', ['link', 'set', 'dev', name, 'up']);
    if (!(await this.verify(spec)).up) throw new Error('Owned AWG device did not become ready');
    await this.save({ ...saved, phase: 'ready', blankHash: null });
    return { ready: true, guarded: true };
  }
  create(value) {
    const spec = specification(value);
    return this.exclusive(async () => {
      if ((await this.load()).phase !== 'empty') throw new Error('Existing lifecycle requires recovery');
      if (await this.link(spec.owner.interfaceName)) throw new Error('Existing interface will not be adopted');
      await this.activateGuard([spec.owner.interfaceName]);
      const saved = { version: 1, phase: 'creating', spec, blankHash: null };
      await this.save(saved); return this.finishCreation(saved);
    });
  }
  async finishRemoval(saved) {
    if (await this.link(saved.spec.owner.interfaceName)) {
      await this.verify(saved.spec);
      await this.run('ip', ['link', 'delete', 'dev', saved.spec.owner.interfaceName]);
    }
    if (await this.link(saved.spec.owner.interfaceName)) throw new Error('Owned device removal not confirmed');
    await this.save(empty()); return { removed: true, guarded: true };
  }
  remove() {
    return this.exclusive(async () => {
      const saved = await this.load();
      if (saved.phase !== 'ready') throw new Error('Only a ready owned lifecycle can be removed');
      await this.verify(saved.spec);
      await this.activateGuard([saved.spec.owner.interfaceName]);
      const intent = { ...saved, phase: 'removing' }; await this.save(intent);
      return this.finishRemoval(intent);
    });
  }
  recover() {
    return this.exclusive(async () => {
      let saved = await this.load();
      if (saved.phase === 'empty') return { ready: false };
      await this.activateGuard([saved.spec.owner.interfaceName]);
      if (saved.phase === 'removing') return this.finishRemoval(saved);
      if (saved.phase === 'ready' && await this.link(saved.spec.owner.interfaceName)) {
        const state = await this.verify(saved.spec, true);
        // Link down is recoverable only after full identity/config/address proof.
        if (!state.up) {
          // Linux can discard IPv6 addresses on administrative link-down.
          // Restore only missing declared addresses after rejecting extras.
          const actual = await this.addresses(saved.spec);
          for (const cidr of saved.spec.addresses.filter(a => !actual.includes(a))) {
            await this.run('ip', ['address', 'add', cidr, 'dev', saved.spec.owner.interfaceName]);
          }
          await this.run('ip', ['link', 'set', 'dev', saved.spec.owner.interfaceName, 'up']);
        }
        if (!(await this.verify(saved.spec)).up) throw new Error('Owned AWG device remains down');
        return { ready: true, guarded: true };
      }
      if (saved.phase === 'ready') { saved = { ...saved, phase: 'creating' }; await this.save(saved); }
      return this.finishCreation(saved);
    });
  }
}
module.exports = { CellAwgLifecycle };
