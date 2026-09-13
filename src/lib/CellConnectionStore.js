'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodeInvitation } = require('./CellInvitation');
const { signRegistration, verifyRegistration } = require('./CellRegistration');
const { parseRegistration } = require('./CellRegistrationHandler');
const { registerOverTls } = require('./CellRegistrationTransport');
const queues = new Map();

// Single service process; CLI must use that process, not independently write here.
class CellConnectionStore {
  constructor(filePath, identityStore, { connect = registerOverTls, io = fs } = {}) {
    this.filePath = path.resolve(filePath);
    this.identityStore = identityStore;
    this.connect = connect;
    this.io = io;
  }

  async read() {
    let raw;
    try {
      const stat = await this.io.lstat(this.filePath);
      if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid cell connection file');
      if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Cell connection permissions are too broad');
      raw = await this.io.readFile(this.filePath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let state;
    try {
      state = JSON.parse(raw);
      if (state.version !== 1 || !['pending', 'registered'].includes(state.status)) throw new Error();
      const fields = ['version', 'status', 'invitationId', 'host', 'port', 'controllerKey', 'cellKey',
        ...(state.status === 'pending' ? ['expiresAt', 'request'] : [])];
      if (JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(fields.sort())) throw new Error();
      // Reuse invitation endpoint validation, without requiring an unexpired invitation.
      const validated = decodeInvitation(Buffer.from(JSON.stringify({ version: 1, kind: 'cell-invitation',
        id: state.invitationId, host: state.host, port: state.port, controllerKey: state.controllerKey,
        secret: Buffer.alloc(32).toString('base64url'), expiresAt: 1 })).toString('base64url'), 0);
      const identity = await this.identityStore.load('cell');
      if (state.cellKey !== identity.publicKey) throw new Error();
      if (state.status === 'pending') {
        parseRegistration(Buffer.from(JSON.stringify(state.request)));
        verifyRegistration(state.request, validated.controllerKey, state.request.issuedAt);
        if (state.request.cellKey !== state.cellKey || state.request.invitationId !== state.invitationId
          || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= state.request.issuedAt) throw new Error();
      }
    } catch { throw new Error('Invalid cell connection state; automatic replacement is disabled'); }
    return state;
  }

  async save(state) {
    const directory = path.dirname(this.filePath);
    await this.io.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.cell-connection-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await this.io.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.io.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await this.io.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await this.io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  exclusive(operation) {
    const previous = queues.get(this.filePath) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    queues.set(this.filePath, task);
    const cleanup = () => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); };
    task.then(cleanup, cleanup);
    return task;
  }

  begin(code) {
    return this.exclusive(async () => {
      if (await this.read()) throw new Error('Cell connection already exists; resume instead');
      const invitation = decodeInvitation(code);
      const identity = await this.identityStore.load('cell');
      const request = signRegistration(invitation, identity.privateKey);
      await this.save({ version: 1, status: 'pending', invitationId: invitation.id,
        host: invitation.host, port: invitation.port, controllerKey: invitation.controllerKey,
        cellKey: identity.publicKey, expiresAt: invitation.expiresAt, request });
      return { status: 'pending' };
    });
  }

  resume() {
    return this.exclusive(async () => {
      const state = await this.read();
      if (!state) throw new Error('No pending cell connection');
      if (state.status === 'registered') return { status: 'registered' };
      if (state.expiresAt <= Date.now()) throw new Error('Cell invitation expired; operator action required');
      verifyRegistration(state.request, state.controllerKey);
      // connect is a trusted local transport which verifies the signed receipt.
      const result = await this.connect({ host: state.host, port: state.port,
        controllerKey: state.controllerKey, request: state.request });
      if (result.status !== 'registered' || result.controllerKey !== state.controllerKey
        || result.cellKey !== state.cellKey || result.invitationId !== state.invitationId) {
        throw new Error('Cell registration confirmation mismatch');
      }
      await this.save({ version: 1, status: 'registered', host: state.host, port: state.port,
        controllerKey: state.controllerKey, cellKey: state.cellKey, invitationId: state.invitationId });
      return { status: 'registered' };
    });
  }
}

module.exports = { CellConnectionStore };
