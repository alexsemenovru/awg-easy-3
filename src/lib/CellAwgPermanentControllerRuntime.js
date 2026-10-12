'use strict';

const fs = require('node:fs/promises');
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
async function openPermanentControllerRuntime({ stateDirectory, runner, keyManager,
  deployment: providedDeployment } = {}) {
  const deployment = providedDeployment || new CellAwgPermanentDeployment({ stateDirectory,
    ...(runner ? { runner } : {}) });
  if (!deployment.stateDirectory || !path.isAbsolute(deployment.stateDirectory)
    || (stateDirectory && path.resolve(stateDirectory) !== path.resolve(deployment.stateDirectory))) {
    throw new TypeError('Permanent controller deployment directory differs');
  }
  const base = await deployment.store.read();
  if (!base) throw new Error('Permanent controller base plan is not reserved');
  const revisionStore = new CellAwgPermanentRevisionStore(
    path.join(deployment.stateDirectory, 'revision.json'), base);
  let missing = false;
  try { await fs.lstat(revisionStore.filePath); }
  catch (error) { if (error.code === 'ENOENT') missing = true; else throw error; }
  if (missing) {
    // A lost revision journal must never be interpreted as revision zero.
    // Guard first, then recover only the exact reserved base. A missing
    // journal after expansion leaves the inter-server path blocked.
    const first = deployment.buildPath({ stateDirectory: deployment.stateDirectory,
      plan: base, runner: deployment.runner });
    if (!first || typeof first.protect !== 'function'
      || typeof first.verifyOperational !== 'function'
      || typeof deployment.resume !== 'function') {
      throw new TypeError('Permanent base recovery requires guarded path');
    }
    await first.protect();
    try {
      await deployment.resume();
      if (!await first.verifyOperational()) {
        throw new Error('Permanent base path not verified');
      }
      await revisionStore.write(revisionStore.empty());
    } catch (error) {
      try { await first.protect(); }
      catch (guardError) {
        throw new AggregateError([error, guardError],
          'Missing permanent revision journal; guard recovery also failed');
      }
      throw new Error('Missing permanent revision journal; base recovery failed',
        { cause: error });
    }
  }
  try { await revisionStore.read(); }
  catch (error) {
    const first = deployment.buildPath({ stateDirectory: deployment.stateDirectory,
      plan: base, runner: deployment.runner });
    if (!first || typeof first.protect !== 'function') {
      throw new AggregateError([error],
        'Invalid permanent revision journal; guarded recovery unavailable');
    }
    try { await first.protect(); }
    catch (guardError) {
      throw new AggregateError([error, guardError],
        'Invalid permanent revision journal; guard recovery also failed');
    }
    throw new Error('Invalid permanent revision journal; control path guarded',
      { cause: error });
  }
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
