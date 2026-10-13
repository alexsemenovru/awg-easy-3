'use strict';

const path = require('node:path');
const { runProcess } = require('./ProcessRunner');
const { ControlIdentityStore } = require('./ControlIdentityStore');
const { CellAwgConnectionStore } = require('./CellAwgConnectionStore');
const { CellAwgPermanentPlanStore } = require('./CellAwgPermanentPlanStore');
const { CellRoutingGuard } = require('./CellRoutingGuard');
const { CellAwgLifecycle } = require('./CellAwgLifecycle');
const { CellAwgTransaction } = require('./CellAwgTransaction');
const { CellNftTransaction } = require('./CellNftTransaction');
const { CellRouteTransaction } = require('./CellRouteTransaction');
const { CellAwgBootstrapCellProvisioner } = require('./CellAwgBootstrapCellProvisioner');
const { prepareCellInitialInstallation } = require('./CellInitialInstallation');
const { openCellInitialRegistration } = require('./CellInitialRegistration');
const { openCellPermanentJoinHost } = require('./CellPermanentJoinHost');

// Concrete first-install assembly. No host command runs while it is opened;
// begin()/resume() remain under the installation-wide lock. This is not yet
// a CLI or a running Cell service.
async function openCellBootstrapInstallationHost({ stateDirectory, interfaceName,
  resources, runner = runProcess, preflight, withLock, prepareStateDirectory } = {}) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || !/^[a-zA-Z0-9_.-]{1,15}$/.test(interfaceName)
    || !resources || !Array.isArray(resources.interfaceNames)
    || resources.interfaceNames.length !== 3
    || resources.interfaceNames[0] !== interfaceName
    || new Set(resources.interfaceNames).size !== 3
    || resources.interfaceNames.some(name => !/^[a-zA-Z0-9_.-]{1,15}$/.test(name))
    || !Array.isArray(resources.nftTables)
    || !['awg_easy_3_bootstrap', 'awg_easy_3_bootstrap_guard',
      'awg_easy_3_control', 'awg_easy_3_control_guard',
      'awg_easy_3', 'awg_easy_3_cell_guard']
      .every(name => resources.nftTables.includes(name))
    || !Array.isArray(resources.udpPorts) || resources.udpPorts.length === 0
    || typeof runner !== 'function') {
    throw new TypeError('Complete Cell bootstrap installation reservation required');
  }
  const file = name => path.join(stateDirectory, name);
  const bootstrapFile = name => file(path.join('bootstrap', name));
  const identityStore = new ControlIdentityStore(file('identity.json'));
  const connectionStore = new CellAwgConnectionStore(file('connection.json'), identityStore);
  const permanentPlanStore = new CellAwgPermanentPlanStore(file(path.join('permanent', 'plan.json')));
  const guard = new CellRoutingGuard({ journalPath: bootstrapFile('guard.json'),
    table: 'awg_easy_3_bootstrap_guard', runner });
  const activateGuard = () => guard.protect([interfaceName]);
  const lifecycle = new CellAwgLifecycle({ journalPath: bootstrapFile('lifecycle.json'),
    activateGuard, runner });
  const awg = new CellAwgTransaction({ journalPath: bootstrapFile('awg.json'),
    activateGuard, runner });
  const firewall = new CellNftTransaction({ journalPath: bootstrapFile('firewall.json'),
    activateGuard, table: 'awg_easy_3_bootstrap', runner });
  const routes = new CellRouteTransaction({ journalPath: bootstrapFile('routes.json'),
    activateGuard, runner });
  const bootstrap = { guard, lifecycle, awg, firewall, routes };
  const provisioner = new CellAwgBootstrapCellProvisioner({ ...bootstrap,
    connection: connectionStore, interfaceName });
  const initial = await prepareCellInitialInstallation({ stateDirectory,
    connectionStore, lifecycle, permanentPlanStore, provisioner, identityStore,
    resources, ...(preflight ? { preflight } : {}), ...(withLock ? { withLock } : {}) },
  prepareStateDirectory);
  const registration = openCellInitialRegistration({ stateDirectory, connectionStore,
    provisioner, ...(withLock ? { withLock } : {}) });
  const permanentJoin = openCellPermanentJoinHost({ stateDirectory,
    interfaceName: resources.interfaceNames[1],
    temporaryInterfaceName: interfaceName, connectionStore, bootstrap, runner,
    ...(withLock ? { withLock } : {}) });
  return Object.freeze({ initial, identityStore, connectionStore,
    permanentPlanStore, bootstrap, provisioner, registration, permanentJoin });
}

module.exports = { openCellBootstrapInstallationHost };
