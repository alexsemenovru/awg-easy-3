'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { runProcess } = require('./ProcessRunner');
const { AwgKeyManager } = require('./AwgKeyManager');
const { generateOfficialProfile } = require('./Awg3Config');
const { ControlIdentityStore } = require('./ControlIdentityStore');
const { CellAwgBootstrapStore } = require('./CellAwgBootstrapStore');
const { CellRoutingGuard } = require('./CellRoutingGuard');
const { CellAwgLifecycle } = require('./CellAwgLifecycle');
const { CellAwgTransaction } = require('./CellAwgTransaction');
const { CellNftTransaction } = require('./CellNftTransaction');
const { CellRouteTransaction } = require('./CellRouteTransaction');
const { CellAwgBootstrapProvisioner } = require('./CellAwgBootstrapProvisioner');
const { CellAwgBootstrapRuntime } = require('./CellAwgBootstrapRuntime');
const { CellAwgBootstrapCoordinator } = require('./CellAwgBootstrapCoordinator');
const { CellAwgPermanentDeployment } = require('./CellAwgPermanentDeployment');
const { CellAwgPermanentRetirementGate } = require('./CellAwgPermanentRetirementGate');
const { openPermanentControllerRuntime } = require('./CellAwgPermanentControllerRuntime');
const { joinPermanentController } = require('./CellAwgPermanentJoin');
const { prepareBootstrapDevice } = require('./CellAwgBootstrapDevice');
const { assertFreeCellHostResources } = require('./CellHostPreflight');
const { withCellInstallationLock } = require('./CellInstallationLock');
const { prepareCellInstallationStateDirectory } = require('./CellInstallationStateDirectory');
const { listenAwgRegistrationOnTunnel } = require('./CellTunnelRegistrationTransport');
const { MainBootstrapConfigStore } = require('./MainBootstrapConfigStore');
const { CellAwgPermanentRevisionStore } = require('./CellAwgPermanentRevisionStore');
const { CellSettingsPublisher } = require('./CellSettingsPublisher');
const { CellUserDescriptorStore } = require('./CellUserDescriptorStore');
const { listenTunnelControlEndpoint } = require('./CellControlService');
const { privateAddress } = require('./CellTunnelControlTransport');
const { validEndpointHost } = require('./CellAwgEndpointHost');
const { StateStore } = require('./StateStore');
const { addressInSubnet } = require('./AddressAllocator');
const { allocateCellInvitationAddresses } = require('./CellInvitationAddressAllocator');
const { assignedSettingsFromState, assignmentFingerprint } = require('./CellAssignedSettings');
const { validateCellSettings } = require('./CellSettingsSchema');

const validName = name => typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,15}$/.test(name);
const validPort = port => Number.isSafeInteger(port) && port >= 1 && port <= 65535;

// Product Main bootstrap assembly. It deliberately does not configure the
// existing user AWG interface, change Docker, or open a listener on creation.
// Every host mutation and invitation transition is under one Linux flock.
async function openMainBootstrapInstallationHost({ stateDirectory, userStateFile, interfaceName,
  controllerAddress, registrationPort, listenPort, endpointHost,
  permanentEndpointPort, permanentControllerAddress, permanentControlPort,
  resources, runner = runProcess,
  keyManager = new AwgKeyManager({ runner }), preflight = assertFreeCellHostResources,
  withLock = withCellInstallationLock,
  prepareStateDirectory = prepareCellInstallationStateDirectory } = {}) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || (userStateFile !== undefined && (typeof userStateFile !== 'string'
      || !path.isAbsolute(userStateFile)))
    || !validName(interfaceName) || !validPort(listenPort)
    || !validPort(registrationPort) || !resources
    || !Array.isArray(resources.interfaceNames) || resources.interfaceNames.length !== 2
    || resources.interfaceNames[0] !== interfaceName
    || !resources.interfaceNames.every(validName)
    || new Set(resources.interfaceNames).size !== 2
    || !Array.isArray(resources.udpPorts) || resources.udpPorts.length !== 2
    || resources.udpPorts[0] !== listenPort
    || new Set(resources.udpPorts).size !== 2
    || !Array.isArray(resources.userInterfaceNames)
    || resources.userInterfaceNames.length !== 1
    || !validName(resources.userInterfaceNames[0])
    || resources.interfaceNames.includes(resources.userInterfaceNames[0])
    || !Array.isArray(resources.userUdpPorts)
    || resources.userUdpPorts.length !== 1
    || !validPort(resources.userUdpPorts[0])
    || resources.udpPorts.includes(resources.userUdpPorts[0])
    || !Array.isArray(resources.nftTables)
    || !['awg_easy_3_bootstrap', 'awg_easy_3_bootstrap_guard',
      'awg_easy_3_control', 'awg_easy_3_control_guard']
      .every(name => resources.nftTables.includes(name))
    || typeof runner !== 'function' || typeof preflight !== 'function'
    || typeof withLock !== 'function' || typeof prepareStateDirectory !== 'function') {
    throw new TypeError('Complete Main bootstrap installation reservation required');
  }
  // Validate all descriptor and address inputs before reserving a directory.
  if (!privateAddress(controllerAddress) || controllerAddress.startsWith('127.')
    || controllerAddress === '::1' || !validEndpointHost(endpointHost)
    || !validPort(permanentEndpointPort) || !validPort(permanentControlPort)
    || registrationPort === permanentControlPort
    || !privateAddress(permanentControllerAddress)
    || permanentControllerAddress.startsWith('127.')
    || permanentControllerAddress === '::1'
    || permanentEndpointPort !== resources.udpPorts[1]
    || permanentControllerAddress === controllerAddress
    || permanentEndpointPort === listenPort
    || typeof keyManager.generateKeyPair !== 'function'
    || typeof keyManager.derivePublicKey !== 'function') {
    throw new TypeError('Invalid Main bootstrap endpoint or key manager');
  }
  // A sidecar on a real Main installation must reserve the values from the
  // persisted panel, not merely trust its own environment. Check before any
  // state directory or host resource is created; fail closed on a mismatch.
  if (userStateFile !== undefined) {
    const userState = await new StateStore(userStateFile).load();
    if (!userState || userState.server.interfaceName !== resources.userInterfaceNames[0]
      || userState.server.listenPort !== resources.userUdpPorts[0]
      || userState.server.panelPort === registrationPort
      || userState.server.panelPort === permanentControlPort
      || [controllerAddress, permanentControllerAddress].some(address =>
        addressInSubnet(address, userState.server.ipv4Subnet)
        || userState.server.ipv6Subnet
          && addressInSubnet(address, userState.server.ipv6Subnet))) {
      throw new Error('Main user panel state does not match the Cell resource reservation');
    }
  }
  // The descriptor's key and profile are supplied by the persisted Main
  // config at invitation time, not accepted as a second independent secret.
  const file = name => path.join(stateDirectory, name);
  const bootstrapFile = name => file(path.join('bootstrap', name));
  const configStore = new MainBootstrapConfigStore(file('config.json'));
  const identityStore = new ControlIdentityStore(file('identity.json'));
  const bootstrapStore = new CellAwgBootstrapStore(file('bootstrap.json'));
  const guard = new CellRoutingGuard({ journalPath: bootstrapFile('guard.json'),
    table: 'awg_easy_3_bootstrap_guard', runner });
  const activateGuard = () => guard.protect([interfaceName]);
  const lifecycle = new CellAwgLifecycle({ journalPath: bootstrapFile('lifecycle.json'),
    activateGuard, runner });
  const awg = new CellAwgTransaction({ journalPath: bootstrapFile('awg.json'),
    activateGuard, runner });
  const firewall = new CellNftTransaction({ journalPath: bootstrapFile('firewall.json'),
    activateGuard, table: 'awg_easy_3_bootstrap', runner });
  const routes = new CellRouteTransaction({ journalPath: bootstrapFile('routes.json'),
    activateGuard, runner });
  const bootstrap = { guard, lifecycle, awg, firewall, routes };
  const provisioner = new CellAwgBootstrapProvisioner({ ...bootstrap, store: bootstrapStore,
    interfaceName, controllerAddress, registrationPort });
  const deployment = new CellAwgPermanentDeployment({ stateDirectory: file('permanent'), runner });
  const gate = new CellAwgPermanentRetirementGate({ deployment, keyManager });
  const lockPath = file('install.lock');
  const locked = work => withLock({ lockPath, work });
  const publisherForCell = cellKey => new CellSettingsPublisher(
    file(path.join('cell-settings', `${crypto.createHash('sha256').update(cellKey).digest('hex')}.json`)),
    identityStore, cellKey);
  const descriptorForCell = cellKey => new CellUserDescriptorStore(
    file(path.join('cell-descriptors', `${crypto.createHash('sha256').update(cellKey).digest('hex')}.json`)));

  async function registeredRecord(invitationId) {
    if (typeof invitationId !== 'string' || !/^[a-f0-9]{32}$/.test(invitationId)) {
      throw new TypeError('Registered invitation identifier required');
    }
    const record = (await bootstrapStore.read()).invitations.find(item => item.id === invitationId);
    if (!record || record.status !== 'consumed' || record.phase !== 'closed'
      || !record.cellKey || !record.awgPublicKey) {
      throw new Error('Registered and permanently joined Cell required');
    }
    return record;
  }

  async function verifiedConfig() {
    const config = await configStore.read();
    if (!config || await keyManager.derivePublicKey(config.privateKey) !== config.publicKey) {
      throw new Error('Missing or mismatched Main bootstrap identity');
    }
    return config;
  }
  async function coordinator(config, verificationGate = gate) {
    const runtime = new CellAwgBootstrapRuntime({ ...bootstrap, store: bootstrapStore,
      interfaceName, privateKey: config.privateKey, listenPort, controllerAddress,
      registrationPort, profile: config.profile,
      verifyPermanent: record => verificationGate.verifyController(record) });
    return { runtime, coordinator: new CellAwgBootstrapCoordinator({ store: bootstrapStore,
      runtime }) };
  }
  async function issueLocked({ cellAddress, permanentCellAddress }) {
    const config = await verifiedConfig();
    const identity = await identityStore.load('controller');
    const { runtime, coordinator: flow } = await coordinator(config);
    if (!await runtime.verifyCurrent()) throw new Error('Main bootstrap path is not verified');
    return flow.issue({ controllerKey: identity.publicKey, endpointHost,
      endpointPort: listenPort, registrationPort, controllerAddress, cellAddress,
      serverPublicKey: config.publicKey, profile: config.profile,
      permanentDescriptor: { version: 1, endpointHost,
        endpointPort: permanentEndpointPort,
        controllerAddress: permanentControllerAddress,
        cellAddress: permanentCellAddress, controlPort: permanentControlPort,
        serverPublicKey: config.publicKey, profile: config.profile } });
  }
  await prepareStateDirectory(stateDirectory);
  return Object.freeze({ bootstrapStore, identityStore, configStore, bootstrap, deployment,
    isPristine: async () => {
      const [config, life, records, permanent, guardState] = await Promise.all([
        configStore.read(), lifecycle.load(), bootstrapStore.read(),
        deployment.store.read(), guard.load(),
      ]);
      return config === null && life.phase === 'empty'
        && records.invitations.length === 0 && permanent === null
        && guardState.interfaces.length === 0 && guardState.pending === null;
    },
    initialize: () => locked(async () => {
      if ((await lifecycle.load()).phase !== 'empty' || await configStore.read()
        || (await bootstrapStore.read()).invitations.length
        || await deployment.store.read()) {
        throw new Error('Existing Main bootstrap state requires resume');
      }
      await preflight({ ...resources, tcpPorts: [registrationPort, permanentControlPort] });
      let identity;
      try { identity = await identityStore.load('controller'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        identity = await identityStore.create('controller');
      }
      const keys = await keyManager.generateKeyPair();
      const profile = generateOfficialProfile();
      const config = await configStore.create({ version: 1, ...keys, profile });
      const spec = await prepareBootstrapDevice({ interfaceName, listenPort,
        controllerAddress, privateKey: config.privateKey, profile,
        userInterfaces: resources.userInterfaceNames,
        userUdpPorts: resources.userUdpPorts, runner });
      await provisioner.initialize(spec);
      const { runtime } = await coordinator(config);
      await runtime.recover();
      return { ready: true, role: 'controller', identity: identity.publicKey };
    }),
    resume: () => locked(async () => {
      await identityStore.load('controller');
      const config = await verifiedConfig();
      const life = await lifecycle.load();
      const records = (await bootstrapStore.read()).invitations;
      if (life.phase === 'empty') {
        if (records.length) {
          throw new Error('Main invitations exist without bootstrap device');
        }
        // An interrupted first install can have persisted the fail-closed
        // guard before the lifecycle journal. Verify that guard from its own
        // journal, then exclude only that owned table from the free scan.
        const guardState = await guard.load();
        const guarded = guardState.interfaces.length > 0 || guardState.pending !== null;
        if (guarded) {
          if (guardState.interfaces.some(name => name !== interfaceName)
            || guardState.pending?.interfaces?.some(name => name !== interfaceName)) {
            throw new Error('Unrelated Main bootstrap guard requires manual recovery');
          }
          await guard.recover();
        }
        await preflight({ ...resources,
          nftTables: guarded ? resources.nftTables.filter(name => name !== guard.table)
            : resources.nftTables,
          tcpPorts: [registrationPort, permanentControlPort] });
        const spec = await prepareBootstrapDevice({ interfaceName, listenPort,
          controllerAddress, privateKey: config.privateKey, profile: config.profile,
          userInterfaces: resources.userInterfaceNames,
          userUdpPorts: resources.userUdpPorts, runner });
        await provisioner.initialize(spec);
      } else if (records.every(item => item.phase === 'closed')) {
        await provisioner.recover();
      } else {
        // A reboot can remove the userspace AWG device, nft tables and routes
        // while leaving a valid ready invitation journal. Restore only the
        // explicitly owned resources under the durable bootstrap guard before
        // asking the coordinator to verify or retire any invitation.
        await guard.recover();
        await guard.protect([interfaceName]);
        await lifecycle.recover();
        const journal = await awg.load();
        if (journal.committed) await awg.recover();
        else if (journal.pending === null) {
          const owned = await lifecycle.load();
          if (owned.phase !== 'ready') throw new Error('Main AWG lifecycle not recovered');
          await awg.initialize(owned.spec.owner);
        } else throw new Error('Main AWG ownership requires manual recovery');
        await firewall.recover();
        await routes.recover();
      }
      const { runtime, coordinator: flow } = await coordinator(config);
      await flow.recover();
      await runtime.recover();
      return { ready: true, role: 'controller' };
    }),
    issue: ({ cellAddress, permanentCellAddress } = {}) => locked(() =>
      issueLocked({ cellAddress, permanentCellAddress })),
    issueAuto: () => locked(async () => issueLocked(allocateCellInvitationAddresses({
      controllerAddress, permanentControllerAddress,
      invitations: (await bootstrapStore.read()).invitations,
    }))),
    join: invitationId => locked(async () => {
      if (typeof invitationId !== 'string' || !/^[a-f0-9]{32}$/.test(invitationId)) {
        throw new TypeError('Registered invitation identifier required');
      }
      const config = await verifiedConfig();
      await identityStore.load('controller');
      const base = await deployment.store.read();
      const permanentRuntime = base
        ? await openPermanentControllerRuntime({ stateDirectory: file('permanent'),
          deployment, keyManager }) : null;
      const verificationGate = permanentRuntime?.gate || gate;
      const { coordinator: flow } = await coordinator(config, verificationGate);
      const options = { bootstrapStore, invitationId, coordinator: flow,
        interfaceName: resources.interfaceNames[1], privateKey: config.privateKey,
        keyManager };
      return permanentRuntime ? permanentRuntime.join(options)
        : joinPermanentController({ ...options, deployment, gate });
    }),
    recoverPermanentBoot: () => locked(async () => {
      if (!await deployment.store.read()) return { configured: false };
      const runtime = await openPermanentControllerRuntime({
        stateDirectory: file('permanent'), deployment, keyManager });
      return runtime.recoverBoot();
    }),
    publish: (invitationId, settings) => locked(async () => {
      const record = await registeredRecord(invitationId);
      const signed = await publisherForCell(record.cellKey).publish(settings);
      return { revision: signed.revision };
    }),
    ensureInitialSettings: invitationId => locked(async () => {
      const record = await registeredRecord(invitationId);
      const publisher = publisherForCell(record.cellKey);
      if ((await publisher.status()).desiredRevision !== null) return { created: false };
      await publisher.publish({ schema: 1, clients: [] });
      return { created: true };
    }),
    settingsStatus: async invitationId => {
      const record = await registeredRecord(invitationId);
      return publisherForCell(record.cellKey).status();
    },
    userDescriptor: async invitationId => {
      const record = await registeredRecord(invitationId);
      return descriptorForCell(record.cellKey).read();
    },
    entryDescriptors: async () => {
      const records = (await bootstrapStore.read()).invitations.filter(record =>
        record.status === 'consumed' && record.phase === 'closed' && record.cellKey);
      return Promise.all(records.map(async record => {
        const [descriptor, published] = await Promise.all([
          descriptorForCell(record.cellKey).read(), publisherForCell(record.cellKey).load(),
        ]);
        const confirmed = published?.confirmed
          ? validateCellSettings(JSON.parse(published.confirmed.desired.payload)).clients : [];
        return { id: record.id, descriptor,
          confirmed: Object.fromEntries(confirmed.map(client =>
            [client.id, assignmentFingerprint(client)])) };
      }));
    },
    reconcileClientAssignments: () => locked(async () => {
      if (!userStateFile) return { skipped: 'no-panel-state' };
      const state = await new StateStore(userStateFile).load();
      if (!state || state.version !== 4) return { skipped: 'no-cell-assignments' };
      const records = (await bootstrapStore.read()).invitations.filter(record =>
        record.status === 'consumed' && record.phase === 'closed' && record.cellKey);
      const inventory = await Promise.all(records.map(async record => ({ id: record.id,
        descriptor: await descriptorForCell(record.cellKey).read() })));
      const desired = assignedSettingsFromState(state, inventory);
      let published = 0;
      for (const record of records) {
        const publisher = publisherForCell(record.cellKey);
        const previous = await publisher.load();
        if (previous?.desired.payload === JSON.stringify(desired[record.id])) continue;
        await publisher.publish(desired[record.id]);
        published++;
      }
      return { published };
    }),
    cells: async () => {
      await identityStore.load('controller');
      const records = (await bootstrapStore.read()).invitations;
      return Promise.all(records.map(async record => {
        const publicRecord = { id: record.id, status: record.status,
          phase: record.phase, createdAt: record.createdAt };
        if (record.status === 'consumed' && record.phase === 'closed') {
          publicRecord.settings = await publisherForCell(record.cellKey).status();
        }
        return publicRecord;
      }));
    },
    listenControl: () => locked(async () => {
      await identityStore.load('controller');
      await bootstrapStore.read();
      const base = await deployment.store.read();
      if (!base) throw new Error('Permanent Main control plan required');
      const revisionStore = new CellAwgPermanentRevisionStore(
        file(path.join('permanent', 'revision.json')), base);
      const revision = await revisionStore.read();
      if (revision.pending) throw new Error('Pending permanent Main revision');
      const plan = revision.committed || base;
      const current = deployment.buildPath({ stateDirectory: deployment.stateDirectory,
        plan, runner });
      if (!await current.verifyOperational()) {
        throw new Error('Permanent Main control path is not operational');
      }
      return listenTunnelControlEndpoint({ address: permanentControllerAddress,
        port: permanentControlPort, lifecycle: current.lifecycle,
        identityStore, bootstrapStore, publisherForCell, descriptorForCell });
    }),
    listen: async () => {
      const config = await verifiedConfig();
      const { runtime } = await coordinator(config);
      return listenAwgRegistrationOnTunnel({ address: controllerAddress,
        port: registrationPort, lifecycle, identityStore,
        bootstrapStore, bootstrapRuntime: runtime });
    },
  });
}

module.exports = { openMainBootstrapInstallationHost };
