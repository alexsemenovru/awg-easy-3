'use strict';

const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns/promises');
const { CellUserConfigStore } = require('./CellUserConfigStore');
const { GeoIpUpdater } = require('./GeoIpUpdater');
const { openRegisteredCellHost } = require('./CellRegisteredHost');
const { AwgKeyManager } = require('./AwgKeyManager');
const { validateCellUserDescriptor } = require('./CellUserDescriptor');
const { CellDataIdentityStore } = require('./CellDataIdentityStore');
const { CellReceivedDataOfferStore } = require('./CellReceivedDataOfferStore');
const { CellAwgPermanentDeployment } = require('./CellAwgPermanentDeployment');
const { cellDataLinkPlan } = require('./CellDataLinkPlan');
const { stageCellDataPlan } = require('./CellDataStage');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');

// The service deliberately starts from a registered, persistent Cell state.
// Missing GeoIP data cannot silently disable a signed country policy:
// CellRuntimeAdapter validation rejects the policy and leaves its guard on.
async function openCellServiceHost({ config, bootstrapHost,
  openRegistered = openRegisteredCellHost,
  newStore = (...args) => new CellUserConfigStore(...args),
  newGeoUpdater = options => new GeoIpUpdater(options),
  newDataIdentity = (filePath, manager) => new CellDataIdentityStore(filePath, manager),
  newDataDeployment = options => new CellAwgPermanentDeployment(options),
  stageData = stageCellDataPlan,
  keyManager = new AwgKeyManager() } = {}) {
  if (!config || !bootstrapHost || typeof openRegistered !== 'function'
    || typeof newStore !== 'function' || typeof newGeoUpdater !== 'function'
    || typeof newDataDeployment !== 'function' || typeof stageData !== 'function') {
    throw new TypeError('Cell service dependencies required');
  }
  const { stateDirectory, runtimeDirectory, interfaceName, resources } = config;
  if (typeof runtimeDirectory !== 'string' || !path.isAbsolute(runtimeDirectory)) {
    throw new Error('Absolute Cell runtime directory required');
  }
  const store = newStore(path.join(stateDirectory, 'user-config.json'), {
    interfaceName: resources.interfaceNames[2], listenPort: resources.udpPorts[0],
  });
  const user = await store.read();
  if (!user) throw new Error('Cell user tunnel config not installed');
  const connection = await bootstrapHost.connectionStore.read();
  if (connection?.status !== 'registered'
    || user.server.privateKey === connection.permanent?.privateKey) {
    throw new Error('Registered Cell requires a distinct user AWG key');
  }
  const dataIdentity = await newDataIdentity(path.join(stateDirectory, 'data-identity.json'),
    keyManager).ensure();
  if (dataIdentity.privateKey === user.server.privateKey
    || dataIdentity.privateKey === connection.permanent?.privateKey) {
    throw new Error('Cell data link requires an independent AWG key');
  }
  const receivedDataOffer = new CellReceivedDataOfferStore(
    path.join(stateDirectory, 'received-data-offer.json'), user.server);
  const cachedOffer = await receivedDataOffer.read();
  const dataDeployment = newDataDeployment({
    stateDirectory: path.join(stateDirectory, 'data-link'),
    policyTable: 'awg_easy_3_data_cell',
    guardTable: 'awg_easy_3_data_guard_cell', retainGuard: true });
  const stageOffer = async offer => {
    const saved = await dataDeployment.store.read();
    let resolvedEndpointHost;
    if (saved) {
      const endpoint = normalizeAwgConfig(saved.spec.owner.config).peers[0]?.endpoint;
      const match = endpoint?.match(/^\[([^\]]+)\]:\d+$/)
        || endpoint?.match(/^([^:]+):\d+$/);
      if (!match || !net.isIP(match[1])) {
        throw new Error('Stored Cell data endpoint is not a literal address');
      }
      resolvedEndpointHost = match[1];
    } else if (net.isIP(offer.descriptor.endpointHost)) {
      resolvedEndpointHost = offer.descriptor.endpointHost;
    } else {
      const answers = await dns.lookup(offer.descriptor.endpointHost, { all: true });
      resolvedEndpointHost = answers.find(row => row.family === 4)?.address
        || answers.find(row => row.family === 6)?.address;
      if (!resolvedEndpointHost) throw new Error('Data endpoint DNS resolution failed');
    }
    const expected = cellDataLinkPlan({ offer, privateKey: dataIdentity.privateKey,
      resolvedEndpointHost });
    return stageData({ deployment: dataDeployment, expected });
  };
  let host;
  const userDescriptor = config.endpointHost ? validateCellUserDescriptor({
    version: 1, endpointHost: config.endpointHost, endpointPort: user.server.listenPort,
    serverPublicKey: await keyManager.derivePublicKey(user.server.privateKey),
    address4: user.server.address4, ipv4Subnet: user.server.ipv4Subnet,
    ...(user.server.address6 ? { address6: user.server.address6,
      ipv6Subnet: user.server.ipv6Subnet } : {}), profile: user.server.profile,
  }) : undefined;
  const geo = newGeoUpdater({ directory: path.join(stateDirectory, 'geoip'),
    install: (snapshot, commit) => host.installGeoSnapshot(snapshot, commit) });
  await geo.load();
  host = await openRegistered({ stateDirectory, runtimeDirectory,
    connectionStore: bootstrapHost.connectionStore,
    identityStore: bootstrapHost.identityStore,
    bootstrap: bootstrapHost.bootstrap,
    temporaryInterfaceName: interfaceName,
    server: user.server, userDescriptor,
    dataPublicKey: dataIdentity.publicKey,
    receiveDataOffer: async offer => {
      await receivedDataOffer.reserve(offer);
      await stageOffer(offer);
    },
    stageDataLink: cachedOffer ? () => stageOffer(cachedOffer) : undefined,
    geoDatabase: async () => geo.current?.database || {} });
  // A missing cache may require a network download. Guard user traffic before
  // waiting for it, not only inside the later permanent-path recovery.
  await host.protectUserTraffic();
  if (!geo.current && await host.requiresGeoDatabase()) await geo.refresh();
  const boot = await host.recoverBoot();
  if (boot.configured !== true) throw new Error('Permanent Cell path not configured');
  if (cachedOffer && typeof host.stageDataLink === 'function') await host.stageDataLink();
  return { host, geo };
}

async function syncCellOnce(options = {}) {
  const { host } = await openCellServiceHost(options);
  return host.syncSettings();
}

async function startCellService({ onFatal = () => {}, ...options } = {}) {
  if (typeof onFatal !== 'function') throw new TypeError('Cell fatal error handler required');
  const { host, geo } = await openCellServiceHost(options);
  const poller = host.createPoller();
  const running = poller.start();
  running.catch(onFatal);
  try { geo.start(); }
  catch (error) { await poller.stop(); throw error; }
  return Object.freeze({ status: 'serving', running,
    close: async () => { try { await geo.stop(); } finally { await poller.stop(); } } });
}

module.exports = { openCellServiceHost, syncCellOnce, startCellService };
