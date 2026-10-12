'use strict';

const { CellAwgPermanentDeployment } = require('./CellAwgPermanentDeployment');
const { CellAwgPermanentRetirementGate } = require('./CellAwgPermanentRetirementGate');
const { CellAwgBootstrapCellRetirement } = require('./CellAwgBootstrapCellRetirement');
const { joinPermanentCell } = require('./CellAwgPermanentJoin');
const { recoverPermanentBoot } = require('./CellAwgPermanentBoot');

// Component assembly for one Cell. The temporary-path retirement rechecks
// exactly the same permanent-path gate that the join uses. The caller still
// owns the cross-process installation lock and the temporary AWG lifecycle.
function createPermanentCellRuntime({ stateDirectory, connectionStore, bootstrap,
  temporaryInterfaceName, receiver, clientRuntime, runner } = {}) {
  if (!connectionStore || typeof connectionStore.read !== 'function'
    || !receiver || typeof receiver.restoreApplied !== 'function'
    || !clientRuntime || typeof clientRuntime.prepareBoot !== 'function'
    || !bootstrap || typeof bootstrap !== 'object') {
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
  });
}

module.exports = { createPermanentCellRuntime };
