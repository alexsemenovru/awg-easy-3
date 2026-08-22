'use strict';

const crypto = require('node:crypto');

const { generatePassword } = require('./BootstrapInstaller');

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
  }

  async requireState() {
    const state = await this.store.load();
    if (!state) throw new Error('AWG-Easy 3 is not initialized');
    return state;
  }

  async verify(password) {
    if (typeof password !== 'string') return false;
    const state = await this.requireState();
    return Boolean(await this.compare(password, state.auth.passwordHash));
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

  async changePassword(currentPassword, newPassword) {
    const state = await this.requireState();
    if (typeof currentPassword !== 'string'
      || !(await this.compare(currentPassword, state.auth.passwordHash))) {
      throw new Error('Current password is incorrect');
    }
    await this.replacePassword(state, newPassword);
  }

  async resetPassword(newPassword = this.passwordGenerator()) {
    const state = await this.requireState();
    await this.replacePassword(state, newPassword);
    return newPassword;
  }
}

module.exports = {
  PasswordManager,
  validatePassword,
};
