'use strict';

const path = require('node:path');
const { openCellSettingsRuntime } = require('./CellSettingsRuntime');
const { createPermanentCellRuntime } = require('./CellAwgPermanentCellRuntime');
const { withCellInstallationLock } = require('./CellInstallationLock');
const { CellSettingsPoller } = require('./CellSettingsPoller');

// Registered Cell assembly only. Initial invitation/bootstrap provisioning is
// a separate installation phase. The installer creates private stateDirectory
// before opening this host and never exposes its internal lock to the UI.
async function openRegisteredCellHost({ stateDirectory, runtimeDirectory,
  connectionStore, identityStore, bootstrap, temporaryInterfaceName,
  server, geoDatabase, runner,
  openSettings = openCellSettingsRuntime,
  openPermanent = createPermanentCellRuntime,
  withLock = withCellInstallationLock } = {}) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || typeof runtimeDirectory !== 'string' || !path.isAbsolute(runtimeDirectory)
    || !connectionStore || typeof connectionStore.read !== 'function'
    || !identityStore || typeof identityStore.load !== 'function'
    || typeof openSettings !== 'function' || typeof openPermanent !== 'function'
    || typeof withLock !== 'function') {
    throw new TypeError('Registered Cell host dependencies required');
  }
  const settings = await openSettings({ connectionStore,
    stateDirectory: path.join(stateDirectory, 'settings'), runtimeDirectory,
    server, ...(geoDatabase ? { geoDatabase } : {}), ...(runner ? { runner } : {}) });
  if (!settings || !settings.adapter || !settings.receiver) {
    throw new TypeError('Registered Cell settings runtime required');
  }
  const permanent = openPermanent({ stateDirectory: path.join(stateDirectory, 'permanent'),
    connectionStore, bootstrap, temporaryInterfaceName,
    receiver: settings.receiver, clientRuntime: settings.adapter,
    ...(runner ? { runner } : {}) });
  if (!permanent || !['recoverBoot', 'join', 'syncSettings']
    .every(name => typeof permanent[name] === 'function')) {
    throw new TypeError('Registered Cell permanent runtime required');
  }
  const lockPath = path.join(stateDirectory, 'install.lock');
  const locked = work => withLock({ lockPath, work });
  const sync = () => locked(() => permanent.syncSettings({ identityStore }));
  return Object.freeze({
    recoverBoot: options => locked(() => permanent.recoverBoot(options)),
    join: options => locked(() => permanent.join(options)),
    syncSettings: sync,
    createPoller: options => new CellSettingsPoller({ ...options, sync }),
  });
}

module.exports = { openRegisteredCellHost };
