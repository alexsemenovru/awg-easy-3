'use strict';

const { ensureTunDevice } = require('./CellTunPreflight');

// One boot step under the installation-wide lock. Listener startup remains
// with the host service, after this function returns successfully.
async function recoverPermanentBoot({ deployment, expansionRuntime = null, receiver = null,
  ensureTun = ensureTunDevice }) {
  if (!deployment || !deployment.store || typeof deployment.store.read !== 'function'
    || typeof deployment.resume !== 'function'
    || typeof deployment.buildPath !== 'function'
    || expansionRuntime !== null && typeof expansionRuntime.recoverCurrent !== 'function'
    || receiver !== null && typeof receiver.restoreApplied !== 'function'
    || typeof ensureTun !== 'function') {
    throw new TypeError('Invalid permanent AWG boot dependencies');
  }
  const plan = await deployment.store.read();
  if (!plan) return { configured: false, applied: null };
  await ensureTun();
  const activePlan = expansionRuntime ? await expansionRuntime.recoverCurrent()
    : (await deployment.resume(), plan);
  const path = deployment.buildPath({ stateDirectory: deployment.stateDirectory,
    plan: activePlan, runner: deployment.runner });
  if (!path || typeof path.verifyOperational !== 'function'
    || !await path.verifyOperational()) {
    throw new Error('Permanent AWG path is not operational after boot recovery');
  }
  const result = receiver ? await receiver.restoreApplied() : { applied: null };
  return { configured: true, applied: result.applied ?? null };
}

module.exports = { recoverPermanentBoot };
