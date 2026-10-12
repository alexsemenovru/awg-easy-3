'use strict';

const path = require('node:path');
const { openPermanentControllerRuntime } = require('./CellAwgPermanentControllerRuntime');
const { withCellInstallationLock } = require('./CellInstallationLock');

// Existing Main Node only. The first permanent plan is reserved by the
// invitation flow; this assembly never invents a base plan from live state.
async function openRegisteredControllerHost({ stateDirectory, runner, keyManager,
  openRuntime = openPermanentControllerRuntime,
  withLock = withCellInstallationLock } = {}) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || typeof openRuntime !== 'function' || typeof withLock !== 'function') {
    throw new TypeError('Registered controller host dependencies required');
  }
  const lockPath = path.join(stateDirectory, 'install.lock');
  const locked = work => withLock({ lockPath, work });
  const runtime = await locked(() => openRuntime({
    stateDirectory: path.join(stateDirectory, 'permanent'),
    ...(runner ? { runner } : {}), ...(keyManager ? { keyManager } : {}) }));
  if (!runtime || typeof runtime.join !== 'function'
    || typeof runtime.recoverBoot !== 'function') {
    throw new TypeError('Registered controller permanent runtime required');
  }
  return Object.freeze({
    join: options => locked(() => runtime.join(options)),
    recoverBoot: options => locked(() => runtime.recoverBoot(options)),
  });
}

module.exports = { openRegisteredControllerHost };
