'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { ApiService } = require('./ApiService');
const { buildAwgArtifacts } = require('./AwgArtifacts');
const { BootstrapInstaller } = require('./BootstrapInstaller');
const { ClientManager } = require('./ClientManager');
const { ClientDiagnostics } = require('./ClientDiagnostics');
const { DiscoveryRelay } = require('./DiscoveryRelay');
const { HttpServer } = require('./HttpServer');
const { PasswordManager } = require('./PasswordManager');
const { runProcess } = require('./ProcessRunner');
const { RuntimeApplier } = require('./RuntimeApplier');
const { SessionManager } = require('./SessionManager');
const { StateStore } = require('./StateStore');

class Application {
  constructor({
    dataDirectory = '/data',
    runtimeDirectory = '/run/awg-easy-3',
    publicDirectory = path.join(__dirname, '..', 'www'),
    runner = runProcess,
    fileSystem = fs,
    discoveryFactory = () => new DiscoveryRelay(),
    httpFactory = (options) => new HttpServer(options),
  } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.runtimeDirectory = path.resolve(runtimeDirectory);
    this.publicDirectory = path.resolve(publicDirectory);
    this.runner = runner;
    this.fs = fileSystem;
    if (typeof discoveryFactory !== 'function' || typeof httpFactory !== 'function') {
      throw new TypeError('discoveryFactory and httpFactory must be functions');
    }
    this.discoveryFactory = discoveryFactory;
    this.httpFactory = httpFactory;
    this.store = new StateStore(path.join(this.dataDirectory, 'state.json'));
    this.applier = new RuntimeApplier({ runtimeDirectory: this.runtimeDirectory, runner });
    this.http = null;
    this.http6 = null;
    this.discovery = null;
    this.state = null;
  }

  async initialize({
    endpointHost,
    wanInterface,
    firstClientName = 'Home admin',
    listenPort = 51820,
    panelPort = 51821,
    uiLanguage = 'en',
  } = {}) {
    const result = await new BootstrapInstaller({ store: this.store }).install({
      endpointHost,
      wanInterface,
      firstClientName,
      listenPort,
      panelPort,
      uiLanguage,
    });
    const artifacts = buildAwgArtifacts({
      server: result.state.server,
      clients: result.state.clients,
    });
    return Object.freeze({
      bootstrapPassword: result.bootstrapPassword,
      panelUrl: `http://${result.state.server.address4}:${result.state.server.panelPort}`,
      vpnLink: artifacts.clientArtifacts['home-admin'].vpnLink,
      nativeConfig: artifacts.clientArtifacts['home-admin'].nativeConfig,
    });
  }

  async settings() {
    const state = await this.store.load();
    if (!state) throw new Error('AWG-Easy 3 is not initialized; run the init command first');
    // An explicit allowlist: never return keys, password hashes or client data.
    return Object.freeze({
      AWG_HOST: state.server.endpointHost,
      AWG_PORT: state.server.listenPort,
      AWG_PANEL_PORT: state.server.panelPort,
      AWG_LANG: state.server.uiLanguage ?? 'en',
    });
  }

  async interfaceActive(interfaceName) {
    try {
      await this.runner('awg', ['show', interfaceName]);
      return true;
    } catch (error) {
      if (error && (error.code === 1 || error.exitCode === 1)) return false;
      throw error;
    }
  }

  async start() {
    const state = await this.store.load();
    if (!state) throw new Error('AWG-Easy 3 is not initialized; run the init command first');
    const artifacts = buildAwgArtifacts({ server: state.server, clients: state.clients });
    await this.applier.apply({
      serverConfig: artifacts.serverConfig,
      nftables: artifacts.nftables,
      interfaceName: state.server.interfaceName,
      interfaceActive: await this.interfaceActive(state.server.interfaceName),
    });
    this.state = state;
    try {
      const passwordManager = new PasswordManager({ store: this.store });
      const sessionManager = new SessionManager({ store: this.store });
      this.discovery = this.discoveryFactory();
      await this.discovery.start(state);
      const clientManager = new ClientManager({
        store: this.store,
        applier: this.applier,
        onStateChanged: (nextState) => this.discovery.refresh(nextState),
      });
      const diagnostics = new ClientDiagnostics({ store: this.store, runner: this.runner });
      const api = new ApiService({ store: this.store, passwordManager, sessionManager, clientManager, diagnostics });
      this.http = this.httpFactory({ api, publicDirectory: this.publicDirectory });
      const listening = await this.http.listen({ host: state.server.address4, port: state.server.panelPort });
      if (state.server.address6 && state.server.ipv6Subnet) {
        this.http6 = this.httpFactory({ api, publicDirectory: this.publicDirectory });
        await this.http6.listen({ host: state.server.address6, port: state.server.panelPort });
      }
      return listening;
    } catch (error) {
      try {
        await this.stop();
      } catch (rollbackError) {
        error.rollbackErrors = Object.freeze(
          rollbackError instanceof AggregateError ? [...rollbackError.errors] : [rollbackError],
        );
      }
      throw error;
    }
  }

  async stop() {
    const errors = [];
    if (this.http) await this.http.close().catch((error) => errors.push(error));
    if (this.http6) await this.http6.close().catch((error) => errors.push(error));
    if (this.discovery) await this.discovery.stop().catch((error) => errors.push(error));
    if (this.state) {
      await this.applier.down({ interfaceName: this.state.server.interfaceName }).catch((error) => errors.push(error));
    }
    this.http = null;
    this.http6 = null;
    this.discovery = null;
    this.state = null;
    if (errors.length > 0) throw new AggregateError(errors, 'Application shutdown failed');
  }

  async resetPassword(password) {
    return new PasswordManager({ store: this.store }).resetPassword(password);
  }

  async exportClient(selector) {
    const query = typeof selector === 'string' ? selector.trim() : '';
    if (!query) throw new Error('Client name or ID is required');
    const state = await this.store.load();
    if (!state) throw new Error('AWG-Easy 3 is not initialized');
    const folded = query.toLocaleLowerCase();
    const client = state.clients.find((item) => item.id === query
      || item.name.trim().toLocaleLowerCase() === folded);
    if (!client) throw new Error(`Unknown client: ${query}`);
    const artifacts = buildAwgArtifacts({ server: state.server, clients: state.clients });
    return Object.freeze({ clientName: client.name, vpnLink: artifacts.clientArtifacts[client.id].vpnLink });
  }

}

module.exports = { Application };
