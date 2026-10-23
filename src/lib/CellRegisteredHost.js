'use strict';

const path = require('node:path');
const { openCellSettingsRuntime } = require('./CellSettingsRuntime');
const { createPermanentCellRuntime } = require('./CellAwgPermanentCellRuntime');
const { withCellInstallationLock } = require('./CellInstallationLock');
const { CellSettingsPoller } = require('./CellSettingsPoller');
const { verifySettings } = require('./CellSettings');
const { buildCellArtifacts } = require('./CellArtifacts');

// Registered Cell assembly only. Initial invitation/bootstrap provisioning is
// a separate installation phase. The installer creates private stateDirectory
// before opening this host and never exposes its internal lock to the UI.
async function openRegisteredCellHost({ stateDirectory, runtimeDirectory,
  connectionStore, identityStore, bootstrap, temporaryInterfaceName,
  server, userDescriptor, dataPublicKey, geoDatabase, runner,
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
    receiver: settings.receiver, clientRuntime: settings.adapter, userDescriptor,
    dataPublicKey,
    ...(runner ? { runner } : {}) });
  if (!permanent || !['recoverBoot', 'join', 'syncSettings']
    .every(name => typeof permanent[name] === 'function')) {
    throw new TypeError('Registered Cell permanent runtime required');
  }
  const lockPath = path.join(stateDirectory, 'install.lock');
  const locked = work => withLock({ lockPath, work });
  const sync = () => locked(() => permanent.syncSettings({ identityStore }));
  return Object.freeze({
    protectUserTraffic: () => locked(() => settings.adapter.prepareBoot()),
    recoverBoot: options => locked(() => permanent.recoverBoot(options)),
    join: options => locked(() => permanent.join(options)),
    syncSettings: sync,
    createPoller: options => new CellSettingsPoller({ ...options, sync }),
    requiresGeoDatabase: () => locked(async () => {
      const applied = (await settings.receiver.load())?.applied;
      if (!applied) return false;
      const { settings: payload } = verifySettings(applied, settings.receiver.trust);
      return payload.clients.some(client => client.geoPolicy.mode !== 'off');
    }),
    installGeoSnapshot: (snapshot, commit) => locked(async () => {
      if (!snapshot || !snapshot.database || typeof commit !== 'function') {
        throw new TypeError('Validated GeoIP snapshot and commit required');
      }
      const applied = (await settings.receiver.load())?.applied;
      if (!applied) { await commit(); return; }
      const { settings: payload } = verifySettings(applied, settings.receiver.trust);
      const previous = await settings.adapter.geoDatabase();
      // First boot can have signed GeoIP rules but no cache yet. The caller
      // refreshes before recoverBoot, which applies them under the traffic guard.
      if (!previous || Object.keys(previous).length === 0) {
        buildCellArtifacts({ server, settings: payload, geoDatabase: snapshot.database });
        await commit();
        return;
      }
      const before = buildCellArtifacts({ server, settings: payload, geoDatabase: previous });
      const after = buildCellArtifacts({ server, settings: payload,
        geoDatabase: snapshot.database });
      const changed = before.nftables !== after.nftables;
      if (changed) await settings.adapter.apply(payload, { geoDatabase: snapshot.database });
      try { await commit(); }
      catch (error) {
        if (changed) {
          try { await settings.adapter.apply(payload, { geoDatabase: previous }); }
          catch (rollbackError) {
            error.rollbackErrors = Object.freeze([rollbackError]);
          }
        }
        throw error;
      }
    }),
  });
}

module.exports = { openRegisteredCellHost };
