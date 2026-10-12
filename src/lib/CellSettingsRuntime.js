'use strict';

const path = require('node:path');
const { CellRuntimeAdapter } = require('./CellRuntimeAdapter');
const { CellSettingsReceiver } = require('./CellSettingsReceiver');

// Assemble only from a validated, registered Cell connection. The same
// durable directory anchors the settings journal and the traffic guard.
async function openCellSettingsRuntime({ connectionStore, stateDirectory,
  runtimeDirectory, server, geoDatabase, runner } = {}) {
  if (!connectionStore || typeof connectionStore.read !== 'function'
    || typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || typeof runtimeDirectory !== 'string' || !path.isAbsolute(runtimeDirectory)
    || !server || typeof server !== 'object') {
    throw new TypeError('Registered cell connection and absolute runtime directories required');
  }
  const connection = await connectionStore.read();
  if (!connection || connection.status !== 'registered'
    || typeof connection.cellKey !== 'string'
    || typeof connection.controllerKey !== 'string') {
    throw new Error('Registered cell connection required before settings runtime');
  }
  const adapter = new CellRuntimeAdapter({ server, runtimeDirectory,
    stateDirectory: path.join(stateDirectory, 'client-runtime'),
    ...(geoDatabase ? { geoDatabase } : {}), ...(runner ? { runner } : {}) });
  const receiver = new CellSettingsReceiver(path.join(stateDirectory, 'settings.json'), {
    controllerKey: connection.controllerKey, cellKey: connection.cellKey,
    validate: settings => adapter.validate(settings),
    apply: settings => adapter.apply(settings),
  });
  return Object.freeze({ adapter, receiver });
}

module.exports = { openCellSettingsRuntime };
