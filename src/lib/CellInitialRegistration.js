'use strict';

const path = require('node:path');
const { withCellInstallationLock } = require('./CellInstallationLock');

// Registration is deliberately separate from provisioning: a failed network
// exchange leaves the same pending identity/invitation for a bounded retry.
function openCellInitialRegistration({ stateDirectory, connectionStore, provisioner,
  withLock = withCellInstallationLock } = {}) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || !connectionStore || !['read', 'resume'].every(name => typeof connectionStore[name] === 'function')
    || !provisioner || typeof provisioner.recover !== 'function'
    || typeof withLock !== 'function') {
    throw new TypeError('Cell registration dependencies required');
  }
  const lockPath = path.join(stateDirectory, 'install.lock');
  return Object.freeze({
    register: () => withLock({ lockPath, work: async () => {
      const connection = await connectionStore.read();
      if (connection?.status === 'registered') return { status: 'registered' };
      if (connection?.status !== 'pending') {
        throw new Error('Pending Cell bootstrap required before registration');
      }
      // Re-establish and verify the owned AWG path, routes, nft rules and guard
      // before any registration request can leave this Cell.
      await provisioner.recover();
      const result = await connectionStore.resume();
      if (result?.status !== 'registered') {
        throw new Error('Cell registration did not receive a signed receipt');
      }
      return { status: 'registered' };
    } }),
  });
}

module.exports = { openCellInitialRegistration };
