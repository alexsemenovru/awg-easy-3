'use strict';

const crypto = require('node:crypto');

const { generatePassword } = require('./BootstrapInstaller');
const { AUTH_STATE_VERSION } = require('./StateStore');
const { generateSecret, matchingStep, provisioningUri } = require('./Totp');

const defaultHash = (password) => require('bcryptjs').hash(password, 12);
const defaultCompare = (password, hash) => require('bcryptjs').compare(password, hash);

const validatePassword = (password) => {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new TypeError('password must contain between 12 and 128 characters');
  }
  if (/[\0\r\n]/.test(password)) {
    throw new TypeError('password must not contain null bytes or line breaks');
  }
  return password;
};

class PasswordManager {
  constructor({
    store,
    hash = defaultHash,
    compare = defaultCompare,
    passwordGenerator = generatePassword,
    randomBytes = crypto.randomBytes,
    clock = () => Date.now(),
    serializeOperation,
  } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
      throw new TypeError('store must provide load and save methods');
    }
    for (const [name, dependency] of Object.entries({ hash, compare, passwordGenerator, randomBytes })) {
      if (typeof dependency !== 'function') throw new TypeError(`${name} must be a function`);
    }
    this.store = store;
    this.hash = hash;
    this.compare = compare;
    this.passwordGenerator = passwordGenerator;
    this.randomBytes = randomBytes;
    this.clock = clock;
    this.queue = Promise.resolve();
    this.serializeOperation = serializeOperation;
  }

  serialize(action) {
    if (this.serializeOperation) return this.serializeOperation(action);
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async requireState() {
    const state = await this.store.load();
    if (!state) throw new Error('AWG-Easy 3 is not initialized');
    return state;
  }

  async verify(password) {
    if (typeof password !== 'string') return false;
    const state = await this.requireState();
    return (state.auth.mode ?? 'password') !== 'totp'
      && Boolean(await this.compare(password, state.auth.passwordHash));
  }

  async mode() {
    return (await this.requireState()).auth.mode ?? 'password';
  }

  async authenticate(password, code) {
    return this.serialize(async () => {
      const state = await this.requireState();
      const mode = state.auth.mode ?? 'password';
      if (mode !== 'totp' && (typeof password !== 'string'
        || !(await this.compare(password, state.auth.passwordHash)))) return false;
      if (mode === 'password') return true;
      const step = matchingStep(state.auth.totpSecret, code, this.clock(), state.auth.lastTotpStep ?? -1);
      if (step === null) return false;
      await this.store.save({ ...state, auth: { ...state.auth, lastTotpStep: step } });
      return true;
    });
  }

  async prove(state, { password, code } = {}) {
    const mode = state.auth.mode ?? 'password';
    if (mode !== 'totp' && (typeof password !== 'string'
      || !(await this.compare(password, state.auth.passwordHash)))) throw new Error('Invalid credentials');
    if (mode === 'password') return state;
    const step = matchingStep(state.auth.totpSecret, code, this.clock(), state.auth.lastTotpStep ?? -1);
    if (step === null) throw new Error('Invalid credentials');
    return { ...state, auth: { ...state.auth, lastTotpStep: step } };
  }

  async beginTotp(proof) {
    return this.serialize(async () => {
      const state = await this.prove(await this.requireState(), proof);
      if (state.auth.totpSecret) throw new Error('Disable existing codes before setting up new ones');
      const secret = generateSecret(this.randomBytes);
      await this.store.save({ ...state, version: AUTH_STATE_VERSION,
        auth: { ...state.auth, pendingTotp: { secret, createdAt: this.clock() } } });
      return { secret, uri: provisioningUri(secret) };
    });
  }

  async confirmTotp(password, code) {
    return this.serialize(async () => {
      const state = await this.requireState();
      const pending = state.auth.pendingTotp;
      if (!pending || this.clock() - pending.createdAt > 10 * 60_000) throw new Error('TOTP setup expired');
      if (typeof password !== 'string' || !(await this.compare(password, state.auth.passwordHash))) {
        throw new Error('Invalid credentials');
      }
      const step = matchingStep(pending.secret, code, this.clock());
      if (step === null) throw new Error('Invalid credentials');
      await this.store.save({ ...state, version: AUTH_STATE_VERSION, auth: {
        passwordHash: state.auth.passwordHash,
        sessionSecret: this.randomBytes(48).toString('base64url'),
        mode: 'password_totp', totpSecret: pending.secret, lastTotpStep: step,
      } });
    });
  }

  async setMode(targetMode, proof, newPassword) {
    return this.serialize(async () => {
      if (!['password', 'password_totp', 'totp'].includes(targetMode)) throw new TypeError('Invalid authentication mode');
      const state = await this.prove(await this.requireState(), proof);
      if (targetMode !== 'password' && !state.auth.totpSecret) throw new Error('Set up codes first');
      let passwordHash = state.auth.passwordHash;
      if ((state.auth.mode ?? 'password') === 'totp' && targetMode !== 'totp') {
        validatePassword(newPassword);
        passwordHash = await this.hash(newPassword);
      }
      const auth = { passwordHash, sessionSecret: this.randomBytes(48).toString('base64url') };
      if (targetMode !== 'password') Object.assign(auth, {
        mode: targetMode, totpSecret: state.auth.totpSecret, lastTotpStep: state.auth.lastTotpStep,
      });
      await this.store.save({ ...state, version: AUTH_STATE_VERSION, auth });
    });
  }

  async replacePassword(state, newPassword) {
    validatePassword(newPassword);
    const passwordHash = await this.hash(newPassword);
    const sessionSecret = this.randomBytes(48).toString('base64url');
    return this.store.save({
      ...state,
      auth: { passwordHash, sessionSecret },
    });
  }

  async changePassword(currentPassword, newPassword, code) {
    return this.serialize(async () => {
      const state = await this.requireState();
      if ((state.auth.mode ?? 'password') === 'totp') throw new Error('Use SSH reset to create a new password');
      let proved;
      try { proved = await this.prove(state, { password: currentPassword, code }); }
      catch { throw new Error('Current password is incorrect'); }
      validatePassword(newPassword);
      await this.store.save({ ...proved, auth: { ...proved.auth,
        passwordHash: await this.hash(newPassword),
        sessionSecret: this.randomBytes(48).toString('base64url'),
      } });
    });
  }

  async resetPassword(newPassword = this.passwordGenerator()) {
    await this.serialize(async () => {
      const state = await this.requireState();
      await this.replacePassword(state, newPassword);
    });
    return newPassword;
  }
}

module.exports = {
  PasswordManager,
  validatePassword,
};
