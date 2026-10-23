'use strict';

const { matchesAwgConfig } = require('./CellAwgSnapshot');
const { nftFingerprint } = require('./CellNftOwnership');

// The first guarded data plan is durable. Reconciliation uses its original
// ownership tag instead of regenerating/adopting a same-name AWG interface.
// Changes to keys, addresses, endpoint or routes require an explicit future
// transition and cannot occur on an ordinary service poll.
async function stageCellDataPlan({ deployment, expected }) {
  if (!deployment || !deployment.retainGuard || !deployment.store
    || typeof deployment.store.read !== 'function'
    || typeof deployment.install !== 'function'
    || typeof deployment.resume !== 'function'
    || !expected || expected.retainGuard !== true
    || deployment.policyTable !== expected.policyTable
    || deployment.guardTable !== expected.guardTable) {
    throw new TypeError('Guarded Cell data deployment and matching plan required');
  }
  const saved = await deployment.store.read();
  if (!saved) {
    const result = await deployment.install(expected.plan);
    return { created: true, ...result };
  }
  const actual = saved.spec.owner, desired = expected.plan.spec.owner;
  if (actual.interfaceName !== desired.interfaceName || actual.mtu !== desired.mtu
    || !matchesAwgConfig(desired.config, actual.config)
    || JSON.stringify(saved.spec.addresses) !== JSON.stringify(expected.plan.spec.addresses)
    || JSON.stringify(saved.routeCommands) !== JSON.stringify(expected.plan.routeCommands)
    || nftFingerprint(saved.policy, deployment.policyTable)
      !== nftFingerprint(expected.plan.policy, deployment.policyTable)) {
    throw new Error('Stored data link plan changed; explicit transition required');
  }
  const result = await deployment.resume();
  return { created: false, ...result };
}

module.exports = { stageCellDataPlan };
