'use strict';
const { encodeStateText, parseStateText } = require('./PrivateStateText');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AwgKeyManager, validateKey } = require('./AwgKeyManager');
const { decodeAwgBootstrapInvitation } = require('./CellAwgBootstrapInvitation');
const { signAwgRegistration, renewAwgRegistration, verifyAwgRegistration,
  parseAwgRegistration } = require('./CellAwgRegistration');
const { registerAwgOverTunnel } = require('./CellTunnelRegistrationTransport');
const { validatePermanentDescriptor } = require('./CellAwgPermanentDescriptor');

const queues = new Map();
const MAX_BYTES = 16384;
const invalid = () => { throw new Error('Invalid AWG cell connection state; automatic replacement is disabled'); };
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').length === 32
  && Buffer.from(value, 'base64url').toString('base64url') === value;

function publicFromPrivate(privateKey) {
  validateKey(privateKey, 'cellPrivateKey');
  const secret = Buffer.from(privateKey, 'base64');
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), secret]);
  const publicKey = crypto.createPublicKey(crypto.createPrivateKey({ key: der,
    format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
  return Buffer.from(publicKey, 'base64url').toString('base64');
}

function permanentKeys(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'presharedKey,privateKey,publicKey') invalid();
  try {
    validateKey(value.privateKey, 'cellPrivateKey');
    validateKey(value.publicKey, 'cellPublicKey');
    validateKey(value.presharedKey, 'cellPresharedKey');
    if (publicFromPrivate(value.privateKey) !== value.publicKey) invalid();
  } catch { invalid(); }
  return { ...value };
}

class CellAwgConnectionStore {
  constructor(filePath, identityStore, { keyManager = new AwgKeyManager(),
    connect = registerAwgOverTunnel, now = Date.now } = {}) {
    if (typeof filePath !== 'string' || !filePath || !identityStore
      || typeof identityStore.load !== 'function' || !keyManager
      || typeof keyManager.generatePeerKeys !== 'function'
      || typeof connect !== 'function' || typeof now !== 'function') {
      throw new TypeError('AWG cell connection dependencies required');
    }
    this.filePath = path.resolve(filePath);
    Object.assign(this, { identityStore, keyManager, connect, now });
  }

  async validate(state) {
    if (!state || state.version !== 2 || !['pending', 'registered'].includes(state.status)) invalid();
    const identity = await this.identityStore.load('cell');
    const keys = permanentKeys(state.permanent);
    if (state.cellKey !== identity.publicKey) invalid();
    if (state.status === 'pending') {
      if (Object.keys(state).sort().join(',') !==
        'cellKey,invitation,permanent,request,status,version') invalid();
      let invitation;
      try { invitation = decodeAwgBootstrapInvitation(
        Buffer.from(JSON.stringify(state.invitation)).toString('base64url'), 0); }
      catch { invalid(); }
      try { parseAwgRegistration(Buffer.from(JSON.stringify(state.request))); }
      catch { invalid(); }
      verifyAwgRegistration(state.request, invitation.controllerKey, state.request.issuedAt);
      if (state.request.cellKey !== state.cellKey
        || state.request.invitationId !== invitation.id
        || state.request.secret !== invitation.secret
        || state.request.awgPublicKey !== keys.publicKey
        || state.request.awgPresharedKey !== keys.presharedKey
        || state.request.issuedAt >= invitation.expiresAt) invalid();
    } else {
      const fields = ['cellKey', 'controllerKey', 'invitationId', 'permanent', 'status', 'version'];
      if (Object.hasOwn(state, 'controllerPath')) {
        validatePermanentDescriptor(state.controllerPath);
        fields.push('controllerPath');
      }
      if (Object.hasOwn(state, 'authorityKey')) {
        if (!token(state.authorityKey) || state.authorityKey === state.controllerKey) invalid();
        fields.push('authorityKey');
      }
      if (Object.hasOwn(state, 'authorityGeneration')) {
        if (!state.authorityKey || !Number.isSafeInteger(state.authorityGeneration) || state.authorityGeneration < 1) invalid();
        fields.push('authorityGeneration');
      }
      if (Object.keys(state).sort().join(',') !== fields.sort().join(',')
        || typeof state.invitationId !== 'string' || !/^[a-f0-9]{32}$/.test(state.invitationId)
        || !token(state.controllerKey)) invalid();
    }
    return state;
  }

  async read() {
    let raw;
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES
        || (process.platform !== 'win32'
          && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) invalid();
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try { return await this.validate(parseStateText(raw)); } catch { invalid(); }
  }

  async save(state) {
    await this.validate(state);
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > MAX_BYTES) invalid();
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || (process.platform !== 'win32'
      && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) invalid();
    const temporary = path.join(directory, `.awg-connection-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(encodeStateText(data, this.filePath)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await fs.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    }); }
  }

  exclusive(work) {
    const task = (queues.get(this.filePath) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.filePath, task);
    const clear = () => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); };
    task.then(clear, clear);
    return task;
  }

  begin(code) {
    return this.exclusive(async () => {
      if (await this.read()) throw new Error('AWG cell connection already exists; resume instead');
      const invitation = decodeAwgBootstrapInvitation(code, this.now());
      const identity = await this.identityStore.load('cell');
      const permanent = permanentKeys(await this.keyManager.generatePeerKeys());
      if (permanent.publicKey === invitation.serverPublicKey
        || permanent.publicKey === publicFromPrivate(invitation.temporaryPrivateKey)) invalid();
      const request = signAwgRegistration(invitation, identity.privateKey,
        permanent, this.now());
      await this.save({ version: 2, status: 'pending', cellKey: identity.publicKey,
        invitation, permanent, request });
      return { status: 'pending' };
    });
  }

  pinAuthority(authorityKey, generation) {
    return this.exclusive(async () => {
      const state = await this.read();
      if (state?.status !== 'registered' || !token(authorityKey) || authorityKey === state.controllerKey
        || !Number.isSafeInteger(generation) || generation < 1) invalid();
      const prior = state.authorityGeneration ?? 0;
      if (generation < prior || generation === prior && authorityKey !== state.authorityKey) {
        throw new Error('Stale or conflicting permanent Cell authority');
      }
      if (generation === prior) return;
      await this.save({ ...state, authorityKey, authorityGeneration: generation });
    });
  }

  resume() {
    return this.exclusive(async () => {
      const state = await this.read();
      if (!state) throw new Error('No pending AWG cell connection');
      if (state.status === 'registered') return { status: 'registered' };
      const now = this.now();
      if (state.invitation.expiresAt <= now) {
        throw new Error('AWG cell invitation expired; operator action required');
      }
      const identity = await this.identityStore.load('cell');
      const request = renewAwgRegistration(state.request, identity.privateKey, now);
      const result = await this.connect({ address: state.invitation.controllerAddress,
        port: state.invitation.registrationPort, controllerKey: state.invitation.controllerKey,
        request });
      if (result.status !== 'registered'
        || result.controllerKey !== state.invitation.controllerKey
        || result.cellKey !== state.cellKey
        || result.invitationId !== state.invitation.id) {
        throw new Error('AWG cell registration confirmation mismatch');
      }
      await this.save({ version: 2, status: 'registered', cellKey: state.cellKey,
        controllerKey: state.invitation.controllerKey,
        invitationId: state.invitation.id, permanent: state.permanent,
        ...(result.permanent ? { controllerPath: validatePermanentDescriptor(result.permanent) } : {}),
        ...(result.authorityKey ? { authorityKey: result.authorityKey } : {}) });
      return { status: 'registered' };
    });
  }
}

module.exports = { CellAwgConnectionStore, deriveAwgPublicKey: publicFromPrivate };
