'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { validateProfile } = require('./Awg3Config');
const { normalizeClientPolicy } = require('./ClientPolicy');

const STATE_VERSION = 1;

const requiredString = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value)) {
    throw new TypeError(`${field} must be a non-empty single-line string`);
  }
  return value;
};

const optionalString = (value, field) => {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, field);
};

const uniqueField = (clients, field) => {
  const seen = new Set();
  for (const client of clients) {
    const value = client[field];
    if (!value) continue;
    if (seen.has(value)) throw new TypeError(`Duplicate client ${field}: ${value}`);
    seen.add(value);
  }
};

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

const validateState = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('State must be a JSON object');
  }
  if (input.version !== STATE_VERSION) {
    throw new Error(`Unsupported state version: ${input.version ?? 'missing'}; expected ${STATE_VERSION}`);
  }
  if (!input.server || typeof input.server !== 'object' || Array.isArray(input.server)) {
    throw new TypeError('server must be an object');
  }
  if (!input.auth || typeof input.auth !== 'object' || Array.isArray(input.auth)) {
    throw new TypeError('auth must be an object');
  }
  if (!Array.isArray(input.clients) || input.clients.length === 0) {
    throw new TypeError('clients must be a non-empty array');
  }

  const server = {
    ...input.server,
    interfaceName: requiredString(input.server.interfaceName, 'server.interfaceName'),
    wanInterface: requiredString(input.server.wanInterface, 'server.wanInterface'),
    privateKey: requiredString(input.server.privateKey, 'server.privateKey'),
    publicKey: requiredString(input.server.publicKey, 'server.publicKey'),
    address4: requiredString(input.server.address4, 'server.address4'),
    ipv4Subnet: requiredString(input.server.ipv4Subnet, 'server.ipv4Subnet'),
    endpointHost: requiredString(input.server.endpointHost, 'server.endpointHost'),
    address6: optionalString(input.server.address6, 'server.address6'),
    ipv6Subnet: optionalString(input.server.ipv6Subnet, 'server.ipv6Subnet'),
    profile: validateProfile(input.server.profile),
  };

  const listenPort = Number(input.server.listenPort);
  const panelPort = Number(input.server.panelPort);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
    throw new TypeError('server.listenPort must be a valid port');
  }
  if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65_535) {
    throw new TypeError('server.panelPort must be a valid port');
  }
  server.listenPort = listenPort;
  server.panelPort = panelPort;

  const auth = {
    passwordHash: requiredString(input.auth.passwordHash, 'auth.passwordHash'),
    sessionSecret: requiredString(input.auth.sessionSecret, 'auth.sessionSecret'),
  };

  const clients = input.clients.map((inputClient, index) => {
    if (!inputClient || typeof inputClient !== 'object' || Array.isArray(inputClient)) {
      throw new TypeError(`clients[${index}] must be an object`);
    }
    const policy = normalizeClientPolicy(inputClient);
    return {
      ...inputClient,
      ...policy,
      id: requiredString(inputClient.id, `clients[${index}].id`),
      name: requiredString(inputClient.name, `clients[${index}].name`),
      address4: requiredString(inputClient.address4, `clients[${index}].address4`),
      address6: optionalString(inputClient.address6, `clients[${index}].address6`),
      privateKey: requiredString(inputClient.privateKey, `clients[${index}].privateKey`),
      publicKey: requiredString(inputClient.publicKey, `clients[${index}].publicKey`),
      presharedKey: optionalString(inputClient.presharedKey, `clients[${index}].presharedKey`),
      enabled: inputClient.enabled !== false,
    };
  });

  for (const field of ['id', 'address4', 'address6', 'publicKey']) uniqueField(clients, field);
  if (!clients.some((client) => client.enabled && client.networkGroup === 'home')) {
    throw new Error('State must contain at least one enabled home client');
  }

  return deepFreeze({ version: STATE_VERSION, auth, server, clients });
};

class StateStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new TypeError('State file path is required');
    }
    this.filePath = path.resolve(filePath);
  }

  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    let state;
    try {
      state = JSON.parse(raw);
    } catch (error) {
      throw new Error(`State file is not valid JSON: ${error.message}`);
    }
    return validateState(state);
  }

  async save(input) {
    const state = validateState(input);
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });

    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
    return state;
  }
}

module.exports = {
  STATE_VERSION,
  StateStore,
  validateState,
};

