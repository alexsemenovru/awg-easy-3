'use strict';

const { runProcess } = require('./ProcessRunner');

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

const validateKey = (value, field) => {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new Error(`${field} returned an invalid WireGuard key`);
  }
  return value;
};

class AwgKeyManager {
  constructor({ binary = 'awg', runner = runProcess } = {}) {
    if (typeof binary !== 'string' || binary.trim() === '' || /[\0\r\n]/.test(binary)) {
      throw new TypeError('binary must be a non-empty single-line string');
    }
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.binary = binary;
    this.runner = runner;
  }

  async generatePrivateKey() {
    const result = await this.runner(this.binary, ['genkey']);
    return validateKey(result.stdout, 'awg genkey');
  }

  async derivePublicKey(privateKey) {
    validateKey(privateKey, 'privateKey');
    const result = await this.runner(this.binary, ['pubkey'], { input: `${privateKey}\n` });
    return validateKey(result.stdout, 'awg pubkey');
  }

  async generatePresharedKey() {
    const result = await this.runner(this.binary, ['genpsk']);
    return validateKey(result.stdout, 'awg genpsk');
  }

  async generateKeyPair() {
    const privateKey = await this.generatePrivateKey();
    const publicKey = await this.derivePublicKey(privateKey);
    return Object.freeze({ privateKey, publicKey });
  }

  async generatePeerKeys() {
    const pair = await this.generateKeyPair();
    const presharedKey = await this.generatePresharedKey();
    return Object.freeze({ ...pair, presharedKey });
  }
}

module.exports = {
  AwgKeyManager,
  validateKey,
};
