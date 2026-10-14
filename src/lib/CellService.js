'use strict';

const path = require('node:path');
const { CellUserConfigStore } = require('./CellUserConfigStore');
const { GeoIpUpdater } = require('./GeoIpUpdater');
const { openRegisteredCellHost } = require('./CellRegisteredHost');

// The service deliberately starts from a registered, persistent Cell state.
// Missing GeoIP data cannot silently disable a signed country policy:
// CellRuntimeAdapter validation rejects the policy and leaves its guard on.
async function startCellService({ config, bootstrapHost,
  openRegistered = openRegisteredCellHost,
  newStore = (...args) => new CellUserConfigStore(...args),
  newGeoUpdater = options => new GeoIpUpdater(options),
  onFatal = () => {} } = {}) {
  if (!config || !bootstrapHost || typeof openRegistered !== 'function'
    || typeof newStore !== 'function' || typeof newGeoUpdater !== 'function'
    || typeof onFatal !== 'function') throw new TypeError('Cell service dependencies required');
  const { stateDirectory, runtimeDirectory, interfaceName, resources } = config;
  if (typeof runtimeDirectory !== 'string' || !path.isAbsolute(runtimeDirectory)) {
    throw new Error('Absolute Cell runtime directory required');
  }
  const store = newStore(path.join(stateDirectory, 'user-config.json'), {
    interfaceName: resources.interfaceNames[2], listenPort: resources.udpPorts[0],
  });
  const user = await store.read();
  if (!user) throw new Error('Cell user tunnel config not installed');
  const geo = newGeoUpdater({ directory: path.join(stateDirectory, 'geoip') });
  await geo.load();
  const host = await openRegistered({ stateDirectory, runtimeDirectory,
    connectionStore: bootstrapHost.connectionStore,
    identityStore: bootstrapHost.identityStore,
    bootstrap: bootstrapHost.bootstrap,
    temporaryInterfaceName: interfaceName,
    server: user.server, geoDatabase: async () => geo.current?.database || {} });
  const boot = await host.recoverBoot();
  if (boot.configured !== true) throw new Error('Permanent Cell path not configured');
  const poller = host.createPoller();
  const running = poller.start();
  running.catch(onFatal);
  return Object.freeze({ status: 'serving', running,
    close: () => poller.stop() });
}

module.exports = { startCellService };
