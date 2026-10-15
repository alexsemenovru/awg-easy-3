'use strict';

const path = require('node:path');
const { ControlIdentityStore } = require('./ControlIdentityStore');
const { CellAwgConnectionStore } = require('./CellAwgConnectionStore');
const { CellAwgPermanentPlanStore } = require('./CellAwgPermanentPlanStore');
const { CellSettingsReceiver } = require('./CellSettingsReceiver');
const { CellUserConfigStore } = require('./CellUserConfigStore');

// Local read-only diagnostic. It verifies persisted journals but never opens
// AWG or reports transport addresses, key material, assignments or traffic.
async function readCellStatus(config) {
  if (!config || typeof config.stateDirectory !== 'string'
    || !path.isAbsolute(config.stateDirectory)
    || !Array.isArray(config.resources?.interfaceNames)
    || !Array.isArray(config.resources?.udpPorts)) {
    throw new TypeError('Cell state and reservation required');
  }
  const file = name => path.join(config.stateDirectory, name);
  const identity = new ControlIdentityStore(file('identity.json'));
  const connection = await new CellAwgConnectionStore(file('connection.json'), identity).read();
  const permanent = await new CellAwgPermanentPlanStore(file(path.join('permanent', 'plan.json'))).read();
  const user = await new CellUserConfigStore(file('user-config.json'), {
    interfaceName: config.resources.interfaceNames[2],
    listenPort: config.resources.udpPorts[0],
  }).read();
  let receivedRevision = null;
  let appliedRevision = null;
  if (connection?.status === 'registered') {
    const receiver = new CellSettingsReceiver(file(path.join('settings', 'settings.json')), {
      controllerKey: connection.controllerKey, cellKey: connection.cellKey,
      apply: async () => { throw new Error('Read-only status cannot apply settings'); },
    });
    const settings = await receiver.load();
    receivedRevision = settings?.received.revision ?? null;
    appliedRevision = settings?.applied?.revision ?? null;
  }
  return Object.freeze({ registration: connection?.status ?? 'absent',
    permanentPlan: permanent !== null, userConfigured: user !== null,
    receivedRevision, appliedRevision });
}

module.exports = { readCellStatus };
