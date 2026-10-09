'use strict';

const { ensureTunDevice } = require('./CellTunPreflight');

// One boot step under the installation-wide lock. Listener startup remains
// with the host service, after this function returns successfully.
async function recoverPermanentBoot({ deployment, receiver = null,
  ensureTun = ensureTunDevice }) {
  if (!deployment || !deployment.store || typeof deployment.store.read !== 'function'
    || typeof deployment.resume !== 'function'
    || typeof deployment.buildPath !== 'function'
    || receiver !== null && typeof receiver.restoreApplied !== 'function'
    || typeof ensureTun !== 'function') {
    throw new TypeError('Invalid permanent AWG boot dependencies');
  }
  const plan = await deployment.store.read();
  if (!plan) return { configured: false, applied: null };
  await ensureTun();
  await deployment.resume();
  const path = deployment.buildPath({ stateDirectory: deployment.stateDirectory,
    plan, runner: deployment.runner });
  if (!path || typeof path.verifyOperational !== 'function'
    || !await path.verifyOperational()) {
    throw new Error('Permanent AWG path is not operational after boot recovery');
  }
  const result = receiver ? await receiver.restoreApplied() : { applied: null };
  return { configured: true, applied: result.applied ?? null };
}

module.exports = { recoverPermanentBoot };
