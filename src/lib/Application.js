'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { ApiService } = require('./ApiService');
const { buildAwgArtifacts } = require('./AwgArtifacts');
const { BootstrapInstaller } = require('./BootstrapInstaller');
const { ClientManager } = require('./ClientManager');
const { DiscoveryRelay } = require('./DiscoveryRelay');
const { GeoIpStore } = require('./GeoIpStore');
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
    bundledGeoIpPath = path.join(__dirname, '..', 'data', 'ru-ipv4.txt'),
    publicDirectory = path.join(__dirname, '..', 'www'),
    runner = runProcess,
    fileSystem = fs,
  } = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.runtimeDirectory = path.resolve(runtimeDirectory);
    this.bundledGeoIpPath = path.resolve(bundledGeoIpPath);
    this.publicDirectory = path.resolve(publicDirectory);
    this.runner = runner;
    this.fs = fileSystem;
    this.store = new StateStore(path.join(this.dataDirectory, 'state.json'));
    this.geoIp = new GeoIpStore(path.join(this.dataDirectory, 'ru-ipv4.txt'));
    this.applier = new RuntimeApplier({ runtimeDirectory: this.runtimeDirectory, runner });
    this.http = null;
    this.discovery = null;
    this.state = null;
  }

  async ensureGeoIp() {
    try {
      return await this.geoIp.load();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
      await this.fs.copyFile(this.bundledGeoIpPath, this.geoIp.filePath);
      await this.fs.chmod(this.geoIp.filePath, 0o600);
      return this.geoIp.load();
    }
  }

  async initialize({ endpointHost, wanInterface, firstClientName = 'Home admin' } = {}) {
    const ruIPv4Cidrs = await this.ensureGeoIp();
    const result = await new BootstrapInstaller({ store: this.store }).install({
      endpointHost,
      wanInterface,
      firstClientName,
    });
    const artifacts = buildAwgArtifacts({
      server: result.state.server,
      clients: result.state.clients,
      ruIPv4Cidrs,
    });
    return Object.freeze({
      bootstrapPassword: result.bootstrapPassword,
      panelUrl: `http://${result.state.server.address4}:${result.state.server.panelPort}`,
      vpnLink: artifacts.clientArtifacts['home-admin'].vpnLink,
      nativeConfig: artifacts.clientArtifacts['home-admin'].nativeConfig,
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
    const ruIPv4Cidrs = await this.ensureGeoIp();
    const artifacts = buildAwgArtifacts({ server: state.server, clients: state.clients, ruIPv4Cidrs });
    await this.applier.apply({
      serverConfig: artifacts.serverConfig,
      nftables: artifacts.nftables,
      interfaceName: state.server.interfaceName,
      interfaceActive: await this.interfaceActive(state.server.interfaceName),
    });

    const passwordManager = new PasswordManager({ store: this.store });
    const sessionManager = new SessionManager({ store: this.store });
    this.discovery = new DiscoveryRelay();
    await this.discovery.start(state);
    const clientManager = new ClientManager({
      store: this.store,
      applier: this.applier,
      ruIPv4Cidrs,
      onStateChanged: (nextState) => this.discovery.refresh(nextState),
    });
    const api = new ApiService({ store: this.store, passwordManager, sessionManager, clientManager });
    this.http = new HttpServer({ api, publicDirectory: this.publicDirectory });
    this.state = state;
    return this.http.listen({ host: state.server.address4, port: state.server.panelPort });
  }

  async stop() {
    const errors = [];
    if (this.http) await this.http.close().catch((error) => errors.push(error));
    if (this.discovery) await this.discovery.stop().catch((error) => errors.push(error));
    if (this.state) {
      await this.applier.down({ interfaceName: this.state.server.interfaceName }).catch((error) => errors.push(error));
    }
    this.http = null;
    this.discovery = null;
    this.state = null;
    if (errors.length > 0) throw new AggregateError(errors, 'Application shutdown failed');
  }

  async resetPassword(password) {
    return new PasswordManager({ store: this.store }).resetPassword(password);
  }

  updateGeoIp() {
    return this.geoIp.update();
  }
}

module.exports = { Application };
