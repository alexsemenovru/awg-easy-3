'use strict';

const crypto = require('node:crypto');

const { allocateClientAddresses } = require('./AddressAllocator');
const { buildAwgArtifacts } = require('./AwgArtifacts');
const { AwgKeyManager } = require('./AwgKeyManager');
const { assertActiveHomeRemains, normalizeClientPolicy } = require('./ClientPolicy');
const { validateState } = require('./StateStore');

const ALLOWED_CHANGES = new Set(['name', 'enabled', 'networkGroup', 'routeMode']);

class ClientManager {
  constructor({
    store,
    applier,
    keyManager = new AwgKeyManager(),
    artifactBuilder = buildAwgArtifacts,
    idGenerator = crypto.randomUUID,
    ruIPv4Cidrs = [],
  } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
      throw new TypeError('store must provide load and save methods');
    }
    if (!applier || typeof applier.apply !== 'function') throw new TypeError('applier must provide apply');
    if (!keyManager || typeof keyManager.generatePeerKeys !== 'function') {
      throw new TypeError('keyManager must generate peer keys');
    }
    if (typeof artifactBuilder !== 'function' || typeof idGenerator !== 'function') {
      throw new TypeError('artifactBuilder and idGenerator must be functions');
    }
    if (!Array.isArray(ruIPv4Cidrs)) throw new TypeError('ruIPv4Cidrs must be an array');
    this.store = store;
    this.applier = applier;
    this.keyManager = keyManager;
    this.artifactBuilder = artifactBuilder;
    this.idGenerator = idGenerator;
    this.ruIPv4Cidrs = [...ruIPv4Cidrs];
    this.queue = Promise.resolve();
  }

  serialize(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async requireState() {
    const state = await this.store.load();
    if (!state) throw new Error('AWG-Easy 3 is not initialized');
    return state;
  }

  build(state) {
    return this.artifactBuilder({
      server: state.server,
      clients: state.clients,
      ruIPv4Cidrs: this.ruIPv4Cidrs,
    });
  }

  async applyState(previousState, inputState) {
    const nextState = validateState(inputState);
    const previousArtifacts = this.build(previousState);
    const nextArtifacts = this.build(nextState);
    const applyOptions = {
      serverConfig: nextArtifacts.serverConfig,
      nftables: nextArtifacts.nftables,
      interfaceName: nextState.server.interfaceName,
      interfaceActive: true,
    };
    await this.applier.apply(applyOptions);
    try {
      const savedState = await this.store.save(nextState);
      return Object.freeze({ artifacts: nextArtifacts, state: savedState });
    } catch (error) {
      try {
        await this.applier.apply({
          serverConfig: previousArtifacts.serverConfig,
          nftables: previousArtifacts.nftables,
          interfaceName: previousState.server.interfaceName,
          interfaceActive: true,
        });
      } catch (rollbackError) {
        error.rollbackErrors = Object.freeze([rollbackError]);
      }
      throw error;
    }
  }

  createClient({ name, networkGroup, routeMode } = {}) {
    return this.serialize(async () => {
      const state = await this.requireState();
      const policy = normalizeClientPolicy({ networkGroup, routeMode });
      const addresses = allocateClientAddresses({ server: state.server, clients: state.clients });
      const keys = await this.keyManager.generatePeerKeys();
      const client = {
        id: this.idGenerator(),
        name,
        enabled: true,
        ...policy,
        ...addresses,
        ...keys,
      };
      const result = await this.applyState(state, { ...state, clients: [...state.clients, client] });
      return Object.freeze({
        client: result.state.clients.find((item) => item.id === client.id),
        export: result.artifacts.clientArtifacts[client.id],
      });
    });
  }

  updateClient(clientId, changes) {
    return this.serialize(async () => {
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        throw new TypeError('changes must be an object');
      }
      for (const key of Object.keys(changes)) {
        if (!ALLOWED_CHANGES.has(key)) throw new TypeError(`Client field cannot be changed: ${key}`);
      }
      if ('enabled' in changes && typeof changes.enabled !== 'boolean') {
        throw new TypeError('enabled must be a boolean');
      }
      const state = await this.requireState();
      assertActiveHomeRemains(state.clients, clientId, changes);
      const clients = state.clients.map((client) => client.id === clientId ? { ...client, ...changes } : client);
      const result = await this.applyState(state, { ...state, clients });
      const client = result.state.clients.find((item) => item.id === clientId);
      return Object.freeze({ client, export: result.artifacts.clientArtifacts[clientId] });
    });
  }

  deleteClient(clientId) {
    return this.serialize(async () => {
      const state = await this.requireState();
      assertActiveHomeRemains(state.clients, clientId, { deleted: true });
      const result = await this.applyState(state, {
        ...state,
        clients: state.clients.filter((client) => client.id !== clientId),
      });
      return result.state.clients;
    });
  }

  async getClientExport(clientId) {
    const state = await this.requireState();
    if (!state.clients.some((client) => client.id === clientId)) throw new TypeError(`Unknown client: ${clientId}`);
    return this.build(state).clientArtifacts[clientId];
  }
}

module.exports = { ClientManager };
