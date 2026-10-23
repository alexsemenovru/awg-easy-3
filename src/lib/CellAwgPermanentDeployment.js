'use strict';

const path = require('node:path');
const { runProcess } = require('./ProcessRunner');
const { CellAwgPermanentPlanStore, validatePermanentPlan } = require('./CellAwgPermanentPlanStore');
const { CellAwgPermanentPath } = require('./CellAwgPermanentPath');
const { CellRoutingGuard } = require('./CellRoutingGuard');
const { CellAwgLifecycle } = require('./CellAwgLifecycle');
const { CellAwgTransaction } = require('./CellAwgTransaction');
const { CellRouteTransaction } = require('./CellRouteTransaction');
const { CellNftTransaction } = require('./CellNftTransaction');
const { dataTable } = require('./CellNftOwnership');

function validateTables(policyTable, guardTable, retainGuard) {
  const control = policyTable === 'awg_easy_3_control'
    && guardTable === 'awg_easy_3_control_guard' && !retainGuard;
  const data = dataTable(policyTable)
    && guardTable === policyTable.replace('awg_easy_3_data_', 'awg_easy_3_data_guard_')
    && retainGuard;
  if (!control && !data) throw new TypeError('Invalid permanent AWG table and guard pairing');
}

function permanentPathFromPlan({ stateDirectory, plan, runner = runProcess,
  policyTable = 'awg_easy_3_control', guardTable = 'awg_easy_3_control_guard',
  retainGuard = false }) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)) {
    throw new TypeError('Absolute permanent AWG state directory required');
  }
  validateTables(policyTable, guardTable, retainGuard);
  const saved = validatePermanentPlan(plan, { policyTable });
  const file = name => path.join(stateDirectory, name);
  const interfaceName = saved.spec.owner.interfaceName;
  const guard = new CellRoutingGuard({ journalPath: file('guard.json'),
    table: guardTable, runner });
  const activateGuard = () => guard.protect([interfaceName]);
  const lifecycle = new CellAwgLifecycle({ journalPath: file('lifecycle.json'),
    activateGuard, runner });
  const awg = new CellAwgTransaction({ journalPath: file('awg.json'),
    activateGuard, runner });
  const routes = new CellRouteTransaction({ journalPath: file('routes.json'),
    activateGuard, runner });
  const firewall = new CellNftTransaction({ journalPath: file('firewall.json'),
    activateGuard, table: policyTable, runner });
  return new CellAwgPermanentPath({ lifecycle, awg, routes, firewall, guard,
    retainGuard, ...saved });
}

// The installation-wide lock belongs to the caller. This coordinator does
// not retire a temporary invitation and never alters a different plan.
class CellAwgPermanentDeployment {
  constructor({ stateDirectory, runner = runProcess,
    buildPath = permanentPathFromPlan, policyTable = 'awg_easy_3_control',
    guardTable = 'awg_easy_3_control_guard', retainGuard = false }) {
    if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
      || typeof runner !== 'function' || typeof buildPath !== 'function'
      || typeof retainGuard !== 'boolean') {
      throw new TypeError('Invalid permanent AWG deployment');
    }
    validateTables(policyTable, guardTable, retainGuard);
    this.stateDirectory = stateDirectory;
    this.runner = runner;
    this.buildPath = buildPath;
    Object.assign(this, { policyTable, guardTable, retainGuard });
    this.store = new CellAwgPermanentPlanStore(path.join(stateDirectory, 'plan.json'),
      { policyTable });
  }

  async install(plan, { beforeApply = null } = {}) {
    if (!plan || (Object.hasOwn(plan, 'version') && plan.version !== 1)) {
      throw new TypeError('Unsupported permanent AWG plan version');
    }
    if (beforeApply !== null && typeof beforeApply !== 'function') {
      throw new TypeError('Invalid permanent AWG pre-apply hook');
    }
    const wanted = validatePermanentPlan({ ...plan, version: 1 },
      { policyTable: this.policyTable });
    const saved = await this.store.read();
    if (saved === null) await this.store.reserve(wanted);
    else if (JSON.stringify(saved) !== JSON.stringify(wanted)) {
      throw new Error('Different permanent AWG plan already reserved');
    }
    if (beforeApply) await beforeApply(wanted);
    return this.resume();
  }

  async resume() {
    const plan = await this.store.read();
    if (!plan) throw new Error('Permanent AWG plan has not been reserved');
    const instance = this.buildPath({ stateDirectory: this.stateDirectory,
      plan, runner: this.runner, policyTable: this.policyTable,
      guardTable: this.guardTable, retainGuard: this.retainGuard });
    if (!instance || typeof instance.initialize !== 'function'
      || typeof instance.recover !== 'function'
      || !instance.lifecycle || typeof instance.lifecycle.load !== 'function') {
      throw new TypeError('Invalid permanent AWG path runtime');
    }
    const lifecycle = await instance.lifecycle.load();
    if (lifecycle.phase === 'empty') return instance.initialize();
    if (['creating', 'ready'].includes(lifecycle.phase)) return instance.recover();
    throw new Error('Permanent AWG removal requires explicit recovery');
  }
}

module.exports = { CellAwgPermanentDeployment, permanentPathFromPlan };
