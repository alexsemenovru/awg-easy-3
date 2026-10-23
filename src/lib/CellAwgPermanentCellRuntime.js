'use strict';

const { CellAwgPermanentDeployment } = require('./CellAwgPermanentDeployment');
const { CellAwgPermanentRetirementGate } = require('./CellAwgPermanentRetirementGate');
const { CellAwgBootstrapCellRetirement } = require('./CellAwgBootstrapCellRetirement');
const { joinPermanentCell } = require('./CellAwgPermanentJoin');
const { recoverPermanentBoot } = require('./CellAwgPermanentBoot');
const { syncCellSettings, fetchCellDataOffer } = require('./CellControlService');
const { CellSettingsPoller } = require('./CellSettingsPoller');

// Component assembly for one Cell. The temporary-path retirement rechecks
// exactly the same permanent-path gate that the join uses. The caller still
// owns the cross-process installation lock and the temporary AWG lifecycle.
function createPermanentCellRuntime({ stateDirectory, connectionStore, bootstrap,
  temporaryInterfaceName, receiver, clientRuntime, userDescriptor, dataPublicKey,
  receiveDataOffer, runner, sync = syncCellSettings,
  fetchDataOffer = fetchCellDataOffer } = {}) {
  if (!connectionStore || typeof connectionStore.read !== 'function'
    || !receiver || typeof receiver.restoreApplied !== 'function'
    || !clientRuntime || typeof clientRuntime.prepareBoot !== 'function'
    || !bootstrap || typeof bootstrap !== 'object' || typeof sync !== 'function'
    || (receiveDataOffer !== undefined && typeof receiveDataOffer !== 'function')
    || typeof fetchDataOffer !== 'function') {
    throw new TypeError('Cell connection, bootstrap and settings receiver required');
  }
  const deployment = new CellAwgPermanentDeployment({ stateDirectory,
    ...(runner ? { runner } : {}) });
  const gate = new CellAwgPermanentRetirementGate({ deployment });
  const retirement = new CellAwgBootstrapCellRetirement({ connection: connectionStore,
    lifecycle: bootstrap.lifecycle, awg: bootstrap.awg,
    firewall: bootstrap.firewall, routes: bootstrap.routes, guard: bootstrap.guard,
    interfaceName: temporaryInterfaceName,
    verifyPermanent: connection => gate.verifyCell(connection) });
  const syncSettings = async ({ identityStore } = {}) => {
    const connection = await connectionStore.read();
    if (connection?.status !== 'registered' || !connection.controllerPath) {
      throw new Error('Registered cell has no signed permanent control path');
    }
    if (!await gate.verifyCell(connection)) {
      throw new Error('Permanent AWG control path is not operational');
    }
    const result = await sync({ connectionStore, identityStore, receiver,
      host: connection.controllerPath.controllerAddress,
      port: connection.controllerPath.controlPort, transport: 'tunnel',
      ...(userDescriptor ? { userDescriptor } : {}),
      ...(dataPublicKey ? { dataPublicKey } : {}) });
    if (receiveDataOffer && dataPublicKey) {
      const offer = await fetchDataOffer({ connectionStore, identityStore,
        host: connection.controllerPath.controllerAddress,
        port: connection.controllerPath.controlPort });
      if (offer) await receiveDataOffer(offer);
    }
    return result;
  };
  return Object.freeze({ deployment, gate, retirement,
    join: options => joinPermanentCell({ ...options, connectionStore, deployment, gate,
      retirement }),
    recoverBoot: async options => {
      const result = await recoverPermanentBoot({ ...options, deployment, receiver,
        protectClientTraffic: () => clientRuntime.prepareBoot() });
      if (!result.configured && (await connectionStore.read())?.status === 'registered') {
        throw new Error('Registered cell has no permanent plan; resume join before boot');
      }
      return result;
    },
    syncSettings,
    createPoller: ({ identityStore, ...options } = {}) => new CellSettingsPoller({
      ...options, sync: () => syncSettings({ identityStore }) }),
  });
}

module.exports = { createPermanentCellRuntime };
