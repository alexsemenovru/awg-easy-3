'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createInvitation, completeInvitation, revokeInvitation } = require('./CellInvitation');
const { verifyRegistration } = require('./CellRegistration');

const queues = new Map();
const MAX_RECORDS = 1024;
const MAX_BYTES = 1024 * 1024;
const invalid = () => { throw new Error('Invalid cell enrollment state'); };
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;

function validate(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.invitations)
    || input.invitations.length > MAX_RECORDS) invalid();
  const ids = new Set();
  const keys = new Set();
  const invitations = input.invitations.map(record => {
    if (!record || record.version !== 1 || !id(record.id) || ids.has(record.id)
      || !['pending', 'blocked', 'revoked', 'consumed'].includes(record.status)
      || !time(record.createdAt) || !time(record.expiresAt) || record.expiresAt <= record.createdAt
      || record.expiresAt - record.createdAt > 86400000
      || typeof record.secretHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.secretHash)) invalid();
    ids.add(record.id);
    const result = { version: 1, id: record.id, status: record.status,
      createdAt: record.createdAt, expiresAt: record.expiresAt, secretHash: record.secretHash };
    if (record.status !== 'pending') {
      if (!time(record.changedAt) || record.changedAt < record.createdAt) invalid();
      result.changedAt = record.changedAt;
    }
    if (record.status === 'consumed') {
      if (!id(record.requestId) || !token(record.cellKey) || keys.has(record.cellKey)
        || record.changedAt >= record.expiresAt) invalid();
      keys.add(record.cellKey);
      result.requestId = record.requestId;
      result.cellKey = record.cellKey;
    }
    return result;
  });
  return { version: 1, invitations };
}

// One writer process only. Instances for the same resolved path share a queue.
// CLI must eventually use the running controller, not write this file directly.
class CellEnrollmentStore {
  constructor(filePath, { io = fs } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('Enrollment path required');
    this.filePath = path.resolve(filePath);
    this.io = io;
  }

  async read() {
    let raw;
    try {
      if ((await this.io.stat(this.filePath)).size > MAX_BYTES) invalid();
      raw = await this.io.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, invitations: [] };
      throw error;
    }
    if (Buffer.byteLength(raw) > MAX_BYTES) invalid();
    let parsed;
    try { parsed = parseStateText(raw); } catch { invalid(); }
    return validate(parsed);
  }

  async write(state) {
    const data = JSON.stringify(validate(state));
    if (Buffer.byteLength(data) > MAX_BYTES) invalid();
    const directory = path.dirname(this.filePath);
    await this.io.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.cell-enrollment-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await this.io.open(temporary, 'wx', 0o600);
      await handle.writeFile(data, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.io.rename(temporary, this.filePath);
      // Linux deployment: persist the directory entry before acknowledging.
      if (process.platform !== 'win32') {
        const parent = await this.io.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await this.io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  transaction(change) {
    const previous = queues.get(this.filePath) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const state = await this.read();
      const result = change(state);
      await this.write(state);
      return result;
    });
    queues.set(this.filePath, task);
    const cleanup = () => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); };
    task.then(cleanup, cleanup);
    return task;
  }

  create(options) {
    return this.transaction(state => {
      if (state.invitations.length >= MAX_RECORDS) throw new Error('Cell invitation limit reached');
      const { code, record } = createInvitation(options);
      state.invitations.push(record);
      return code;
    });
  }

  completeSigned(request, controllerKey, now = Date.now()) {
    // controllerKey comes from local controller identity, never from the request.
    const verified = verifyRegistration(request, controllerKey, now);
    return this.complete(request.invitationId, verified, now);
  }

  // Internal state-machine entry point, not an HTTP request handler.
  complete(invitationId, request, now = Date.now()) {
    return this.transaction(state => {
      const index = state.invitations.findIndex(record => record.id === invitationId);
      const result = completeInvitation(state.invitations[index], request, now);
      state.invitations[index] = result;
      // Never expose the secret verifier to the API caller.
      return { id: result.id, status: result.status,
        ...(result.status === 'consumed' ? { cellKey: result.cellKey } : {}) };
    });
  }

  revoke(invitationId, now = Date.now()) {
    return this.transaction(state => {
      const index = state.invitations.findIndex(record => record.id === invitationId);
      const result = revokeInvitation(state.invitations[index], now);
      state.invitations[index] = result;
      return { id: result.id, status: result.status };
    });
  }
}

module.exports = { CellEnrollmentStore };
