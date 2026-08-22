'use strict';

const crypto = require('node:crypto');

const { generateOfficialProfile } = require('./Awg3Config');
const { AwgKeyManager } = require('./AwgKeyManager');
const { STATE_VERSION, validateState } = require('./StateStore');

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const generatePassword = ({ length = 24, randomInt = crypto.randomInt } = {}) => {
  if (!Number.isInteger(length) || length < 16 || length > 128) {
    throw new TypeError('password length must be between 16 and 128');
  }
  let password = '';
  for (let index = 0; index < length; index++) {
    password += PASSWORD_ALPHABET[randomInt(0, PASSWORD_ALPHABET.length)];
  }
  return password;
};

const defaultPasswordHasher = (password) => {
  // Loaded only by the real installer, keeping dependency-injected tests standalone.
  const bcrypt = require('bcryptjs');
  return bcrypt.hash(password, 12);
};

class BootstrapInstaller {
  constructor({
    store,
    keyManager = new AwgKeyManager(),
    passwordHasher = defaultPasswordHasher,
    passwordGenerator = generatePassword,
    randomBytes = crypto.randomBytes,
    profileGenerator = generateOfficialProfile,
  } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
      throw new TypeError('store must provide load and save methods');
    }
    for (const [name, dependency] of Object.entries({
      passwordHasher,
      passwordGenerator,
      randomBytes,
      profileGenerator,
    })) {
      if (typeof dependency !== 'function') throw new TypeError(`${name} must be a function`);
    }
    if (!keyManager || typeof keyManager.generateKeyPair !== 'function'
      || typeof keyManager.generatePeerKeys !== 'function') {
      throw new TypeError('keyManager must generate server and peer keys');
    }
    this.store = store;
    this.keyManager = keyManager;
    this.passwordHasher = passwordHasher;
    this.passwordGenerator = passwordGenerator;
    this.randomBytes = randomBytes;
    this.profileGenerator = profileGenerator;
  }

  async install({
    endpointHost,
    wanInterface,
    interfaceName = 'awg0',
    listenPort = 51820,
    panelPort = 51821,
    ipv4Subnet = '10.8.0.0/24',
    serverAddress4 = '10.8.0.1',
    firstClientAddress4 = '10.8.0.2',
    firstClientName = 'Home admin',
    ipv6,
  }) {
    if (await this.store.load() !== null) {
      throw new Error('AWG-Easy 3 is already initialized; refusing to overwrite state');
    }

    const serverKeys = await this.keyManager.generateKeyPair();
    const clientKeys = await this.keyManager.generatePeerKeys();
    const bootstrapPassword = this.passwordGenerator();
    const passwordHash = await this.passwordHasher(bootstrapPassword);
    const sessionSecret = this.randomBytes(48).toString('base64url');

    const server = {
      interfaceName,
      wanInterface,
      ...serverKeys,
      address4: serverAddress4,
      ipv4Subnet,
      listenPort,
      panelPort,
      endpointHost,
      profile: this.profileGenerator(),
    };
    const client = {
      id: 'home-admin',
      name: firstClientName,
      enabled: true,
      networkGroup: 'home',
      routeMode: 'vpn_all',
      address4: firstClientAddress4,
      ...clientKeys,
    };

    if (ipv6 !== undefined) {
      if (!ipv6 || typeof ipv6 !== 'object' || Array.isArray(ipv6)) {
        throw new TypeError('ipv6 must be an object');
      }
      server.address6 = ipv6.serverAddress;
      server.ipv6Subnet = ipv6.subnet;
      client.address6 = ipv6.firstClientAddress;
    }

    const state = validateState({
      version: STATE_VERSION,
      auth: { passwordHash, sessionSecret },
      server,
      clients: [client],
    });
    const savedState = await this.store.save(state);
    return Object.freeze({ bootstrapPassword, state: savedState });
  }
}

module.exports = {
  BootstrapInstaller,
  PASSWORD_ALPHABET,
  generatePassword,
};
