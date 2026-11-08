'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { validateProfile } = require('./Awg3Config');
const { normalizeClientPolicy } = require('./ClientPolicy');
const { isHomeGroup } = require('./NetworkGroups');
const { clientTraffic } = require('./ClientTraffic');
const { normalizeGeoPolicy } = require('./GeoIpPolicy');

const STATE_VERSION = 1;
const GEO_STATE_VERSION = 2;
const AUTH_STATE_VERSION = 3;
const CELL_STATE_VERSION = 4;

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
  if (![STATE_VERSION, GEO_STATE_VERSION, AUTH_STATE_VERSION, CELL_STATE_VERSION].includes(input.version)) {
    throw new Error(`Unsupported state version: ${input.version ?? 'missing'}; expected 1, 2, 3 or 4`);
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
  if (Boolean(server.address6) !== Boolean(server.ipv6Subnet)) {
    throw new TypeError('server.address6 and server.ipv6Subnet must be configured together');
  }
  if (!['en', 'ru', 'fa', 'es', 'zh-cn'].includes(input.server.uiLanguage ?? 'en')) {
    throw new TypeError('server.uiLanguage must be en, ru, fa, es or zh-cn');
  }
  server.uiLanguage = input.server.uiLanguage ?? 'en';
  if (input.server.ipv6Mode !== undefined) {
    if (!['nat66', 'routed'].includes(input.server.ipv6Mode)) {
      throw new TypeError('server.ipv6Mode must be nat66 or routed');
    }
    if (!server.address6 || !server.ipv6Subnet) {
      throw new TypeError('server.ipv6Mode requires IPv6 addresses');
    }
    server.ipv6Mode = input.server.ipv6Mode;
  }

  const auth = {
    passwordHash: requiredString(input.auth.passwordHash, 'auth.passwordHash'),
    sessionSecret: requiredString(input.auth.sessionSecret, 'auth.sessionSecret'),
  };
  const mode = input.auth.mode ?? 'password';
  if (!['password', 'password_totp', 'totp'].includes(mode)) throw new TypeError('Invalid authentication mode');
  if (mode !== 'password' || input.auth.totpSecret !== undefined || input.auth.pendingTotp !== undefined) {
    if (input.version < AUTH_STATE_VERSION) throw new TypeError('TOTP requires state version 3 or later');
  }
  if (mode !== 'password' && !input.auth.totpSecret) throw new TypeError('TOTP mode requires a secret');
  if (input.auth.totpSecret !== undefined) {
    if (!/^[A-Z2-7]{32}$/.test(input.auth.totpSecret)) throw new TypeError('Invalid TOTP secret');
    auth.totpSecret = input.auth.totpSecret;
  }
  if (input.auth.lastTotpStep !== undefined) {
    if (!Number.isSafeInteger(input.auth.lastTotpStep) || input.auth.lastTotpStep < 0) throw new TypeError('Invalid TOTP step');
    auth.lastTotpStep = input.auth.lastTotpStep;
  }
  if (input.auth.pendingTotp !== undefined) {
    const pending = input.auth.pendingTotp;
    if (!pending || !/^[A-Z2-7]{32}$/.test(pending.secret)
      || !Number.isSafeInteger(pending.createdAt) || pending.createdAt < 0) throw new TypeError('Invalid pending TOTP setup');
    auth.pendingTotp = { secret: pending.secret, createdAt: pending.createdAt };
  }
  if (mode !== 'password') auth.mode = mode;

  const clients = input.clients.map((inputClient, index) => {
    if (!inputClient || typeof inputClient !== 'object' || Array.isArray(inputClient)) {
      throw new TypeError(`clients[${index}] must be an object`);
    }
    const policy = normalizeClientPolicy(inputClient);
    const entryCellId = inputClient.entryCellId;
    const exitNodeId = inputClient.exitNodeId;
    if (exitNodeId !== undefined && (input.version !== CELL_STATE_VERSION
      || typeof exitNodeId !== 'string' || !(exitNodeId === 'main' || /^[a-f0-9]{32}$/.test(exitNodeId)))) {
      throw new TypeError('Cell exit requires state version 4 and a valid node identifier');
    }
    if (entryCellId !== undefined && (input.version !== CELL_STATE_VERSION
      || typeof entryCellId !== 'string' || !/^[a-f0-9]{32}$/.test(entryCellId))) {
      throw new TypeError('Cell entry requires state version 4 and a valid Cell identifier');
    }
    if (inputClient.address6 && !server.address6 && !entryCellId) {
      throw new TypeError('Client IPv6 address requires server IPv6 support');
    }
    return {
      ...inputClient,
      ...(inputClient.geoPolicy === undefined ? {} : { geoPolicy: normalizeGeoPolicy(inputClient.geoPolicy) }),
      ...policy,
      ...(entryCellId ? { entryCellId } : {}),
      id: requiredString(inputClient.id, `clients[${index}].id`),
      name: requiredString(inputClient.name, `clients[${index}].name`),
      address4: requiredString(inputClient.address4, `clients[${index}].address4`),
      address6: optionalString(inputClient.address6, `clients[${index}].address6`),
      privateKey: requiredString(inputClient.privateKey, `clients[${index}].privateKey`),
      publicKey: requiredString(inputClient.publicKey, `clients[${index}].publicKey`),
      presharedKey: optionalString(inputClient.presharedKey, `clients[${index}].presharedKey`),
      ...clientTraffic(inputClient, {
        ipv6Available: Boolean(inputClient.address6 && (entryCellId
          || server.address6 && server.ipv6Subnet)),
      }),
    };
  });

  for (const field of ['id', 'address4', 'address6', 'publicKey']) uniqueField(clients, field);
  if (!clients.some((client) => client.enabled && isHomeGroup(client.networkGroup))) {
    throw new Error('State must contain at least one enabled home client');
  }

  // Keep the format upgrade sticky: older panels ignore geoPolicy but reject v2.
  // Merely updating without enabling GeoIP retains the legacy format.
  const version = input.version === CELL_STATE_VERSION ? CELL_STATE_VERSION
    : input.version === AUTH_STATE_VERSION ? AUTH_STATE_VERSION : input.version === GEO_STATE_VERSION
    || clients.some(client => client.geoPolicy && client.geoPolicy.mode !== 'off')
    ? GEO_STATE_VERSION : STATE_VERSION;
  return deepFreeze({ version, auth, server, clients });
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
      // Older releases ignore the new flags. Fail closed on a manual downgrade:
      // a partially restricted peer must never become unrestricted there.
      const persisted = { ...state, clients: state.clients.map((client) => ({
        ...client,
        enabled: client.ipv4Enabled && (!client.address6 || client.ipv6Enabled),
      })) };
      await handle.writeFile(`${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
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
  AUTH_STATE_VERSION,
  CELL_STATE_VERSION,
  STATE_VERSION,
  StateStore,
  validateState,
};
