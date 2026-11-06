'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { validatePermanentPlan } = require('./CellAwgPermanentPlanStore');

const MAX_BYTES = 3 * 1024 * 1024;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function additive(before, after) {
  const a = validatePermanentPlan(before), b = validatePermanentPlan(after);
  const ao = a.spec.owner, bo = b.spec.owner;
  if (ao.interfaceName !== bo.interfaceName || ao.ownerTag !== bo.ownerTag
    || ao.mtu !== bo.mtu || !same(a.spec.addresses, b.spec.addresses)) {
    throw new Error('Permanent AWG expansion changes ownership');
  }
  const old = normalizeAwgConfig(ao.config), next = normalizeAwgConfig(bo.config);
  if (!same(old.interface, next.interface) || next.peers.length !== old.peers.length + 1
    || old.peers.some(peer => !next.peers.some(candidate => same(peer, candidate)))) {
    throw new Error('Permanent AWG expansion is not one additive peer');
  }
  return b;
}

function onePeerTransition(before, after) {
  const a = validatePermanentPlan(before), b = validatePermanentPlan(after);
  const ao = a.spec.owner, bo = b.spec.owner;
  const old = normalizeAwgConfig(ao.config), next = normalizeAwgConfig(bo.config);
  if (ao.interfaceName !== bo.interfaceName || ao.ownerTag !== bo.ownerTag
    || ao.mtu !== bo.mtu || !same(a.spec.addresses, b.spec.addresses)
    || !same(old.interface, next.interface)) {
    throw new Error('Permanent AWG revision changes ownership');
  }
  const delta = next.peers.length - old.peers.length;
  if (Math.abs(delta) !== 1 || (delta === 1
    ? old.peers.some(peer => !next.peers.some(candidate => same(peer, candidate)))
    : next.peers.some(peer => !old.peers.some(candidate => same(peer, candidate))))) {
    throw new Error('Permanent AWG revision must add or remove exactly one peer');
  }
  return b;
}

function extendsBase(base, committed, revision) {
  const a = validatePermanentPlan(base), b = validatePermanentPlan(committed);
  const ao = a.spec.owner, bo = b.spec.owner;
  const old = normalizeAwgConfig(ao.config), next = normalizeAwgConfig(bo.config);
  if (ao.interfaceName !== bo.interfaceName || ao.ownerTag !== bo.ownerTag
    || ao.mtu !== bo.mtu || !same(a.spec.addresses, b.spec.addresses)
    || !same(old.interface, next.interface)
    || next.peers.length !== old.peers.length + revision
    || old.peers.some(peer => !next.peers.some(candidate => same(peer, candidate)))) {
    throw new Error('Permanent AWG committed revision differs from base identity');
  }
  return b;
}

function sameBaseIdentity(base, committed) {
  const a = validatePermanentPlan(base), b = validatePermanentPlan(committed);
  const ao = a.spec.owner, bo = b.spec.owner;
  const old = normalizeAwgConfig(ao.config), next = normalizeAwgConfig(bo.config);
  if (ao.interfaceName !== bo.interfaceName || ao.ownerTag !== bo.ownerTag
    || ao.mtu !== bo.mtu || !same(a.spec.addresses, b.spec.addresses)
    || !same(old.interface, next.interface)) {
    throw new Error('Permanent AWG committed revision differs from base identity');
  }
  return b;
}

class CellAwgPermanentRevisionStore {
  constructor(filePath, basePlan) {
    if (typeof filePath !== 'string' || !filePath) {
      throw new TypeError('Permanent AWG revision path required');
    }
    this.filePath = path.resolve(filePath);
    this.base = validatePermanentPlan(basePlan);
    this.baseFingerprint = fingerprint(this.base);
  }

  empty() {
    return { version: 1, baseFingerprint: this.baseFingerprint,
      revision: 0, committed: null, pending: null };
  }

  validate(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || Object.keys(state).sort().join(',') !== 'baseFingerprint,committed,pending,revision,version'
      || ![1, 2].includes(state.version) || state.baseFingerprint !== this.baseFingerprint
      || !Number.isSafeInteger(state.revision) || state.revision < 0
      || (state.revision === 0) !== (state.committed === null)) {
      throw new Error('Invalid permanent AWG revision journal');
    }
    let previous = this.base;
    if (state.committed !== null) {
      previous = state.version === 1
        ? extendsBase(this.base, state.committed, state.revision)
        : sameBaseIdentity(this.base, state.committed);
    }
    if (state.pending !== null) {
      if (state.version === 1) additive(previous, state.pending);
      else onePeerTransition(previous, state.pending);
    }
    const normalized = { version: state.version, baseFingerprint: this.baseFingerprint,
      revision: state.revision, committed: state.committed === null ? null : previous,
      pending: state.pending === null ? null : validatePermanentPlan(state.pending) };
    if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_BYTES) {
      throw new Error('Permanent AWG revision journal too large');
    }
    return normalized;
  }

  async read() {
    let raw;
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES
        || (process.platform !== 'win32'
          && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
        throw new Error('Unsafe permanent AWG revision journal');
      }
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return this.empty();
      throw error;
    }
    try { return this.validate(parseStateText(raw)); }
    catch { throw new Error('Corrupt permanent AWG revision journal; automatic replacement disabled'); }
  }

  async write(state) {
    const normalized = this.validate(state);
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const dirStat = await fs.lstat(directory);
    if (!dirStat.isDirectory() || (process.platform !== 'win32'
      && (dirStat.uid !== process.getuid() || (dirStat.mode & 0o077)))) {
      throw new Error('Private permanent AWG revision directory required');
    }
    const temporary = path.join(directory, `.permanent-revision-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(encodeStateText(JSON.stringify(normalized), this.filePath)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally {
      await fs.unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  // Reserve revision zero before the first kernel change. Never replace an
  // existing journal: it may already contain a Cell removal.
  async initialize() {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const dirStat = await fs.lstat(directory);
    if (!dirStat.isDirectory() || (process.platform !== 'win32'
      && (dirStat.uid !== process.getuid() || (dirStat.mode & 0o077)))) {
      throw new Error('Private permanent AWG revision directory required');
    }
    let handle;
    try { handle = await fs.open(this.filePath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') return this.read();
      throw error;
    }
    try {
      await handle.writeFile(encodeStateText(JSON.stringify(this.empty()), this.filePath));
      await handle.sync();
    } finally { await handle.close(); }
    if (process.platform !== 'win32') {
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return this.empty();
  }

  async prepare(nextPlan) {
    const state = await this.read();
    if (state.pending) throw new Error('Pending permanent AWG expansion requires recovery');
    const previous = state.committed || this.base;
    const pending = onePeerTransition(previous, nextPlan);
    const oldCount = normalizeAwgConfig(previous.spec.owner.config).peers.length;
    const newCount = normalizeAwgConfig(pending.spec.owner.config).peers.length;
    await this.write({ ...state, version: newCount < oldCount ? 2 : state.version, pending });
    return pending;
  }

  async commit() {
    const state = await this.read();
    if (!state.pending) throw new Error('No pending permanent AWG expansion');
    const next = { ...state, revision: state.revision + 1,
      committed: state.pending, pending: null };
    await this.write(next);
    return next;
  }
}

module.exports = { CellAwgPermanentRevisionStore, additive };
