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
const { CellRoutingInbox } = require('./CellRoutingInbox');
const { acknowledgeCellRoutingRevision } = require('./CellControlService');
const { CellRoutingCoordinator } = require('./CellRoutingCoordinator');
const { CellDataActivation } = require('./CellDataActivation');
const { compileCellRouting } = require('./CellRoutingPolicy');
const { verifyCellDataHandshake } = require('./CellDataHandshake');
const { addressInSubnet } = require('./AddressAllocator');
const { runProcess } = require('./ProcessRunner');

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
  newRoutingCoordinator = options => new CellRoutingCoordinator(options),
  newDataActivation = options => new CellDataActivation(options),
  compileRouting = compileCellRouting,
  probeData = verifyCellDataHandshake,
  keyManager = new AwgKeyManager(), runner = runProcess } = {}) {
  if (!config || !bootstrapHost || typeof openRegistered !== 'function'
    || typeof newStore !== 'function' || typeof newGeoUpdater !== 'function'
    || typeof newDataDeployment !== 'function' || typeof stageData !== 'function'
    || typeof newRoutingCoordinator !== 'function' || typeof newDataActivation !== 'function'
    || typeof compileRouting !== 'function' || typeof probeData !== 'function'
    || typeof runner !== 'function') {
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
    guardTable: 'awg_easy_3_data_guard_cell', retainGuard: true, runner });
  let stagedInProcess = false;
  const stageOffer = async offer => {
    if (stagedInProcess) return { created: false, staged: true };
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
    const result = await stageData({ deployment: dataDeployment, expected });
    stagedInProcess = true;
    return result;
  };
  let host;
  let routingActivated = false;
  let geoCandidate = null;
  const routingInbox = new CellRoutingInbox(path.join(stateDirectory, 'routing-inbox.json'), {
    controllerKey: connection.controllerKey, cellKey: connection.cellKey,
    nodeId: connection.invitationId,
    assignments: () => host.appliedAssignments(),
    apply: async (view, _revision, geoDatabase) => {
      if (!view.panel || !addressInSubnet(view.panel.address4,
        activeOffer.descriptor.controllerClientSubnet4)
        || view.panel.address6 && (!activeOffer.descriptor.controllerClientSubnet6
          || !addressInSubnet(view.panel.address6,
            activeOffer.descriptor.controllerClientSubnet6))
        || view.links.length !== 1 || view.links[0].peer !== 'main'
        || view.links[0].ipv4 !== true) {
        throw new Error('Signed routing view differs from pinned data link');
      }
      const saved = await dataDeployment.store.read();
      if (!saved) throw new Error('Cell data link not staged');
      const dataPath = dataDeployment.buildPath({ stateDirectory: dataDeployment.stateDirectory,
        plan: saved, runner, policyTable: dataDeployment.policyTable,
        guardTable: dataDeployment.guardTable, retainGuard: true });
      const routing = newRoutingCoordinator({
        directory: path.join(stateDirectory, 'routing-runtime'), runner,
        verifyInterfaces: async names => names.length === 2
          && names.includes(user.server.interfaceName)
          && names.includes(dataPath.interfaceName)
          && await dataPath.verifyOwned()
          && await host.verifyUserRuntime(),
      });
      const policy = compileRouting({ routingView: view, nodeId: connection.invitationId,
        context: { clientInterface: user.server.interfaceName,
          wanInterface: user.server.wanInterface,
          nat66: user.server.ipv6Mode === 'nat66',
          links: { main: { interfaceName: dataPath.interfaceName,
            table: 52000, priority: 20000 } }, panel: view.panel },
        geoDatabase: geoDatabase || geo.current?.database || {} });
      const activation = newDataActivation({ dataPath, routing,
        verifyDataLink: () => probeData({
          interfaceName: dataPath.interfaceName,
          peerPublicKey: activeOffer.descriptor.controllerPublicKey, runner }) });
      const spec = { version: 1,
        interfaces: [user.server.interfaceName, dataPath.interfaceName],
        commands: policy.commands, nftSnapshot: policy.nftSnapshot };
      await activation.activate(spec);
      await host.releaseUserGuard(async () =>
        await host.verifyUserRuntime()
        && await routing.verifyOperational(spec)
        && await dataPath.verifyOperational()
        && await probeData({ interfaceName: dataPath.interfaceName,
          peerPublicKey: activeOffer.descriptor.controllerPublicKey, runner }));
    },
  });
  let activeOffer = cachedOffer;
  const userDescriptor = config.endpointHost ? validateCellUserDescriptor({
    version: 1, endpointHost: config.endpointHost, endpointPort: user.server.listenPort,
    serverPublicKey: await keyManager.derivePublicKey(user.server.privateKey),
    address4: user.server.address4, ipv4Subnet: user.server.ipv4Subnet,
    ...(user.server.address6 ? { address6: user.server.address6,
      ipv6Subnet: user.server.ipv6Subnet } : {}), profile: user.server.profile,
  }) : undefined;
  const geo = newGeoUpdater({ directory: path.join(stateDirectory, 'geoip'),
    install: async (snapshot, commit) => {
      const previous = geo.current?.database || {};
      try {
        await host.installGeoSnapshot(snapshot, async () => {
          // The user firewall has already been updated. Verify it against this
          // candidate while the signed routing policy is reapplied.
          geoCandidate = snapshot.database;
          if (routingActivated) await routingInbox.refreshApplied(snapshot.database);
          await commit();
        });
      } catch (error) {
        // The host has rolled its user firewall back by this point. Restore
        // the previous route too, then release the user guard only if both
        // policies verify again.
        geoCandidate = null;
        if (routingActivated) {
          try { await routingInbox.refreshApplied(previous); }
          catch (rollbackError) { error.rollbackErrors = [rollbackError]; }
        }
        throw error;
      } finally { geoCandidate = null; }
    } });
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
      activeOffer = offer;
    },
    receiveRoutingRevision: async (envelope, offer) => {
      if (!activeOffer || JSON.stringify(activeOffer) !== JSON.stringify(offer)) {
        throw new Error('Routing revision has no pinned Cell data offer');
      }
      const prior = await routingInbox.load();
      await routingInbox.receive(envelope);
      if (prior?.applied?.revision === envelope.revision
        && (!routingActivated || await host.userGuardActive())) {
        await routingInbox.restoreApplied();
      }
      routingActivated = true;
    },
    acknowledgeRoutingRevision: ({ identityStore, host, port }) =>
      acknowledgeCellRoutingRevision({ connectionStore: bootstrapHost.connectionStore,
        identityStore, routingInbox, host, port }),
    stageDataLink: cachedOffer ? () => stageOffer(cachedOffer) : undefined,
    retainUserGuard: true,
    geoDatabase: async () => geoCandidate || geo.current?.database || {} });
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
