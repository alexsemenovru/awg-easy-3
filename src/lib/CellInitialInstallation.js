'use strict';

const path = require('node:path');
const { decodeAwgBootstrapInvitation } = require('./CellAwgBootstrapInvitation');
const { assertFreeCellHostResources } = require('./CellHostPreflight');
const { withCellInstallationLock } = require('./CellInstallationLock');
const { prepareCellInstallationStateDirectory } = require('./CellInstallationStateDirectory');

// First Cell bootstrap only. The product uses prepareCellInitialInstallation
// to create/verify stateDirectory. The Cell identity is created under the
// same lock as the invitation. Permanent path and settings sync are separate.
function openCellInitialInstallation({ stateDirectory, connectionStore, lifecycle,
  permanentPlanStore, provisioner, identityStore, resources,
  preflight = assertFreeCellHostResources,
  withLock = withCellInstallationLock } = {}) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || !connectionStore || !['read', 'begin'].every(name => typeof connectionStore[name] === 'function')
    || !lifecycle || typeof lifecycle.load !== 'function'
    || !permanentPlanStore || typeof permanentPlanStore.read !== 'function'
    || !provisioner || !['initialize', 'recover'].every(name => typeof provisioner[name] === 'function')
    || !identityStore || !['load', 'create'].every(name => typeof identityStore[name] === 'function')
    || (connectionStore.identityStore && connectionStore.identityStore !== identityStore)
    || !resources || typeof resources !== 'object'
    || typeof preflight !== 'function' || typeof withLock !== 'function') {
    throw new TypeError('Initial Cell installation dependencies required');
  }
  const lockPath = path.join(stateDirectory, 'install.lock');
  const locked = work => withLock({ lockPath, work });

  return Object.freeze({
    begin: code => locked(async () => {
      // Reject malformed/expired codes before any state or host mutation.
      decodeAwgBootstrapInvitation(code);
      const [connection, bootstrap, permanent] = await Promise.all([
        connectionStore.read(), lifecycle.load(), permanentPlanStore.read(),
      ]);
      if (connection !== null || bootstrap.phase !== 'empty' || permanent !== null) {
        throw new Error('Existing Cell state requires recovery, not a new invitation');
      }
      await preflight(resources);
      try { await identityStore.load('cell'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await identityStore.create('cell');
      }
      // A failed provisioner leaves a pending invitation and its independent
      // fail-closed bootstrap guard for resume(), never a replacement identity.
      await connectionStore.begin(code);
      return provisioner.initialize(code);
    }),
    resume: () => locked(async () => {
      const connection = await connectionStore.read();
      if (connection?.status !== 'pending' || !connection.invitation) {
        throw new Error('Pending Cell bootstrap invitation required for recovery');
      }
      const bootstrap = await lifecycle.load();
      if (bootstrap.phase === 'empty') {
        // The connection record may have been fsynced before the first device
        // was created. This is still a fresh host allocation, not owned recovery.
        if (await permanentPlanStore.read() !== null) {
          throw new Error('Permanent Cell plan exists without bootstrap device');
        }
        await preflight(resources);
        const code = Buffer.from(JSON.stringify(connection.invitation)).toString('base64url');
        return provisioner.initialize(code);
      }
      if (!['creating', 'ready'].includes(bootstrap.phase)) {
        throw new Error('Bootstrap lifecycle requires manual recovery');
      }
      // Existing resources belong to the journal; a free-resource scan would
      // mistake them for another service. The provisioner verifies ownership.
      return provisioner.recover();
    }),
  });
}

// Product entry point: validate dependencies before creating any directory,
// then create/verify the private state root before the lock is opened.
async function prepareCellInitialInstallation(options = {},
  prepareStateDirectory = prepareCellInstallationStateDirectory) {
  const host = openCellInitialInstallation(options);
  if (typeof prepareStateDirectory !== 'function') throw new TypeError('Cell directory preparation required');
  await prepareStateDirectory(options.stateDirectory);
  return host;
}

module.exports = { openCellInitialInstallation, prepareCellInitialInstallation };
