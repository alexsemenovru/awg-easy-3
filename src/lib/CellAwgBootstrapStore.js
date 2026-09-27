'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { validateKey } = require('./AwgKeyManager');
const { privateAddress } = require('./CellTunnelControlTransport');
const { verifyRegistration } = require('./CellRegistration');

const queues = new Map();
const MAX_RECORDS = 64;
const MAX_BYTES = 1024 * 1024;
const invalid = () => { throw new Error('Invalid AWG bootstrap state'); };
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;

function validateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 2 || !id(value.id)
    || !['pending', 'consumed', 'revoked'].includes(value.status)
    || !['preparing', 'ready', 'closing', 'closed'].includes(value.phase)
    || !time(value.createdAt) || !time(value.expiresAt)
    || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > 86400000
    || typeof value.secretHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.secretHash)
    || !privateAddress(value.cellAddress) || value.cellAddress.startsWith('127.')
    || value.cellAddress === '::1' || ![4, 6].includes(net.isIP(value.cellAddress))
    || (value.phase !== 'closed' && value.status === 'revoked' && value.phase !== 'closing')
    || (value.phase === 'closed' && value.status === 'pending')
    || (value.phase === 'preparing' && value.status !== 'pending')
    || (value.phase === 'ready' && value.status === 'revoked')) invalid();
  try { validateKey(value.temporaryPublicKey, 'temporaryPublicKey'); }
  catch { invalid(); }
  if (value.phase === 'closed') {
    if (value.temporaryPresharedKey !== null) invalid();
  } else {
    try { validateKey(value.temporaryPresharedKey, 'temporaryPresharedKey'); }
    catch { invalid(); }
  }
  const base = ['version', 'id', 'status', 'phase', 'createdAt', 'expiresAt', 'secretHash',
    'temporaryPublicKey', 'temporaryPresharedKey', 'cellAddress'];
  if (value.status === 'consumed') {
    if (!id(value.requestId) || !token(value.cellKey) || !time(value.changedAt)
      || value.changedAt >= value.expiresAt) invalid();
    base.push('requestId', 'cellKey', 'changedAt');
  } else if (value.status === 'revoked') {
    if (!time(value.changedAt)) invalid();
    base.push('changedAt');
  }
  if (Object.keys(value).sort().join(',') !== base.sort().join(',')) invalid();
  return { ...value };
}

function validateState(input) {
  if (!input || input.version !== 2 || !Array.isArray(input.invitations)
    || input.invitations.length > MAX_RECORDS
    || Object.keys(input).sort().join(',') !== 'invitations,version') invalid();
  const ids = new Set(), cellKeys = new Set(), activeKeys = new Set(), activeAddresses = new Set();
  const invitations = input.invitations.map(value => {
    const record = validateRecord(value);
    if (ids.has(record.id)) invalid();
    ids.add(record.id);
    if (record.status === 'consumed') {
      if (cellKeys.has(record.cellKey)) invalid();
      cellKeys.add(record.cellKey);
    }
    if (record.phase !== 'closed') {
      if (activeKeys.has(record.temporaryPublicKey) || activeAddresses.has(record.cellAddress)) invalid();
      activeKeys.add(record.temporaryPublicKey); activeAddresses.add(record.cellAddress);
    }
    return record;
  });
  return { version: 2, invitations };
}

class CellAwgBootstrapStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('Bootstrap path required');
    this.filePath = path.resolve(filePath);
  }

  async read() {
    let text;
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES
        || (process.platform !== 'win32'
          && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) invalid();
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 2, invitations: [] };
      throw error;
    }
    if (Buffer.byteLength(text) > MAX_BYTES) invalid();
    try { return validateState(JSON.parse(text)); } catch { invalid(); }
  }

  async write(state) {
    const text = JSON.stringify(validateState(state));
    if (Buffer.byteLength(text) > MAX_BYTES) invalid();
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || (process.platform !== 'win32'
      && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) invalid();
    const temporary = path.join(directory, `.awg-bootstrap-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  exclusive(change) {
    const task = (queues.get(this.filePath) || Promise.resolve()).catch(() => {}).then(async () => {
      const state = await this.read();
      const result = change(state);
      await this.write(state);
      return result;
    });
    queues.set(this.filePath, task);
    const clear = () => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); };
    task.then(clear, clear);
    return task;
  }

  reserve(input) {
    const record = validateRecord({ ...input, phase: 'preparing' });
    if (record.status !== 'pending') invalid();
    return this.exclusive(state => {
      if (state.invitations.length >= MAX_RECORDS) throw new Error('AWG invitation limit reached');
      state.invitations.push(record);
      validateState(state);
      return { id: record.id, phase: 'preparing' };
    });
  }

  markReady(invitationId) {
    return this.exclusive(state => {
      const record = state.invitations.find(item => item.id === invitationId);
      if (!record || record.phase !== 'preparing' || record.status !== 'pending') {
        throw new Error('Bootstrap peer is not preparing');
      }
      record.phase = 'ready';
      return { id: record.id, phase: 'ready' };
    });
  }

  abandonPreparing(invitationId, now = Date.now()) {
    return this.exclusive(state => {
      const record = state.invitations.find(item => item.id === invitationId);
      if (!record || record.phase !== 'preparing' || record.status !== 'pending' || !time(now)) {
        throw new Error('Bootstrap peer is not preparing');
      }
      record.status = 'revoked'; record.phase = 'closing'; record.changedAt = now;
      return { id: record.id, phase: 'closing' };
    });
  }

  completeSigned(request, controllerKey, now = Date.now()) {
    const proof = verifyRegistration(request, controllerKey, now);
    return this.exclusive(state => {
      const record = state.invitations.find(item => item.id === request.invitationId);
      if (!record || record.phase !== 'ready' || record.expiresAt <= now) {
        throw new Error('AWG invitation unavailable');
      }
      const hash = crypto.createHash('sha256').update(proof.secret).digest();
      if (!crypto.timingSafeEqual(hash, Buffer.from(record.secretHash, 'hex'))) {
        throw new Error('AWG invitation unavailable');
      }
      if (record.status === 'consumed') {
        if (record.requestId !== proof.requestId || record.cellKey !== proof.cellKey) {
          throw new Error('AWG invitation already consumed');
        }
      } else if (record.status === 'pending') {
        record.status = 'consumed'; record.changedAt = now;
        record.requestId = proof.requestId; record.cellKey = proof.cellKey;
      } else throw new Error('AWG invitation unavailable');
      return { id: record.id, status: 'consumed', cellKey: record.cellKey };
    });
  }

  beginClose(invitationId, { revoke = false, now = Date.now() } = {}) {
    return this.exclusive(state => {
      const record = state.invitations.find(item => item.id === invitationId);
      if (!record || record.phase === 'preparing' || record.phase === 'closed'
        || !time(now) || (revoke && record.status === 'consumed')
        || (!revoke && record.status === 'pending')) {
        throw new Error('Bootstrap close requires explicit recovery or cell removal');
      }
      if (revoke) { record.status = 'revoked'; record.changedAt = now; }
      record.phase = 'closing';
      return { id: record.id, phase: 'closing' };
    });
  }

  markClosed(invitationId) {
    return this.exclusive(state => {
      const record = state.invitations.find(item => item.id === invitationId);
      if (!record || record.phase !== 'closing') throw new Error('Bootstrap peer is not closing');
      record.phase = 'closed'; record.temporaryPresharedKey = null;
      return { id: record.id, phase: 'closed' };
    });
  }
}

module.exports = { CellAwgBootstrapStore };
