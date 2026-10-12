'use strict';

const path = require('node:path');
const { CellAwgPermanentDeployment } = require('./CellAwgPermanentDeployment');
const { CellAwgPermanentRevisionStore } = require('./CellAwgPermanentRevisionStore');
const { CellAwgPermanentExpansionRuntime } = require('./CellAwgPermanentExpansionRuntime');
const { CellAwgPermanentRetirementGate } = require('./CellAwgPermanentRetirementGate');
const { joinPermanentController } = require('./CellAwgPermanentJoin');
const { recoverPermanentBoot } = require('./CellAwgPermanentBoot');

// Open only after the first permanent plan has been reserved. Keeping the
// revision journal, expansion runtime, retirement gate and boot recovery in
// one assembly prevents a multi-cell controller from accidentally verifying
// or restoring the stale one-cell base plan.
async function openPermanentControllerRuntime({ stateDirectory, runner, keyManager } = {}) {
  const deployment = new CellAwgPermanentDeployment({ stateDirectory,
    ...(runner ? { runner } : {}) });
  const base = await deployment.store.read();
  if (!base) throw new Error('Permanent controller base plan is not reserved');
  const revisionStore = new CellAwgPermanentRevisionStore(
    path.join(stateDirectory, 'revision.json'), base);
  const expansionRuntime = new CellAwgPermanentExpansionRuntime({ deployment, revisionStore });
  const gate = new CellAwgPermanentRetirementGate({ deployment, revisionStore,
    ...(keyManager ? { keyManager } : {}) });
  return Object.freeze({ deployment, revisionStore, expansionRuntime, gate,
    join: options => joinPermanentController({ ...options, deployment, expansionRuntime, gate,
      ...(keyManager ? { keyManager } : {}) }),
    recoverBoot: options => recoverPermanentBoot({ ...options, deployment, expansionRuntime }),
  });
}

module.exports = { openPermanentControllerRuntime };
