'use strict';
const path = require('node:path');
const { withCellInstallationLock } = require('./CellInstallationLock');
const { CellAwgPermanentDeployment } = require('./CellAwgPermanentDeployment');
const { CellUserConfigStore } = require('./CellUserConfigStore');
const { CellRoutingCoordinator } = require('./CellRoutingCoordinator');
const { CellRoutingGuard } = require('./CellRoutingGuard');
const { CellNftPolicyReceipt } = require('./CellNftPolicyReceipt');
const { CellControlRedirect } = require('./CellControlRedirect');
const { restoredContext, restoredSnapshot } = require('./CellRestoredEndpoint');
const { CellDockerTransit } = require('./CellDockerTransit');
const { CellDockerForwarding } = require('./CellDockerForwarding');
const { RuntimeApplier } = require('./RuntimeApplier');
const { matchesAwgConfig, normalizeAwgConfig } = require('./CellAwgSnapshot');
const { runProcess } = require('./ProcessRunner');

// Terminal host operation ONLY after a root-owned supervisor has stopped the
// exact Cell container and disabled restart. No names, shell commands or paths
// arrive from a remote command. Private journals remain for interrupted retry;
// they must never be booted again as an ordinary Cell after terminal intent.
async function cleanupCellOwnedResources({ config, authorizeStopped, runner = runProcess }) {
  if (typeof authorizeStopped !== 'function') throw new TypeError('Stopped-container authority required');
  return withCellInstallationLock({ lockPath: path.join(config.stateDirectory, 'install.lock'), work: async () => {
    await authorizeStopped();
    const root = config.stateDirectory;
    const user = await new CellUserConfigStore(path.join(root, 'user-config.json'), {
      interfaceName: config.resources.interfaceNames[2], listenPort: config.resources.udpPorts[0] }).read();
    if (!user) throw new Error('Owned user configuration required');
    const runtime = new RuntimeApplier({ runtimeDirectory: config.runtimeDirectory, runner });
    const receipt = new CellNftPolicyReceipt({ filePath: path.join(root, 'settings/client-runtime/nft-receipt.json'), runner });
    const guard = new CellRoutingGuard({ journalPath: path.join(root, 'settings/client-runtime/guard.json'),
      table: 'awg_easy_3_cell_guard', runner });
    const paths = [];
    for (const [role, relative, options] of [['control', 'permanent', {}], ['data', 'data-link', {
      policyTable: 'awg_easy_3_data_cell', guardTable: 'awg_easy_3_data_guard_cell', retainGuard: true }]]) {
      const directory = path.join(root, relative);
      const deployment = new CellAwgPermanentDeployment({ stateDirectory: directory, runner, ...options });
      const plan = await deployment.store.read();
      if (!plan) { if (role === 'control') throw new Error('Permanent control ownership required'); continue; }
      paths.push({ role, plan, runtime: deployment.buildPath({ stateDirectory: directory, plan, runner, ...options }) });
    }
    const names = [user.server.interfaceName, ...paths.map(row => row.runtime.interfaceName)];
    const links = () => runner('ip', ['-d', '-j', 'link', 'show']).then(x => {
      const rows = JSON.parse(x.stdout);
      if (!Array.isArray(rows) || rows.some(row => typeof row?.ifname !== 'string')) throw new Error('Invalid interface inventory');
      return rows;
    });
    const present = await links();
    if (present.some(row => row.ifname === config.interfaceName)) throw new Error('Bootstrap device still exists');
    if (present.some(row => row.ifname === user.server.interfaceName)) {
      const stripped = await runtime.stripSavedConfig(user.server.interfaceName);
      const actual = await runner('awg', ['showconf', user.server.interfaceName]);
      if (!matchesAwgConfig(stripped.stdout, actual.stdout)) throw new Error('Foreign user interface');
    }
    try { await guard.recover(); await guard.protect(names); }
    catch (error) { throw new Error('Cell cleanup user guard failed', { cause: error }); }
    await receipt.assertKnown();
    // Remove exact persisted technical DNAT tuples even when their Go sockets
    // have disappeared with the stopped container. The journal and AWG owner
    // identity authorize deletion, never installation of a replacement route.
    for (const { role, plan, runtime: owned } of paths) {
      const peer = normalizeAwgConfig(plan.spec.owner.config).peers[0]?.endpoint;
      const endpoint = peer?.match(/^\[([^\]]+)\]:(\d+)$/) || peer?.match(/^([^:]+):(\d+)$/);
      const verifyOwned = async tuple => !!endpoint && tuple.interfaceName === owned.interfaceName
        && tuple.ownerTag === plan.spec.owner.ownerTag && tuple.peer4 === endpoint[1] && tuple.peerPort === Number(endpoint[2]);
      if (role === 'control') await new CellControlRedirect({ directory: path.join(root, 'technical'), runner, verifyOwned }).recover();
      const table = `awg_easy_3_restore_${role}`;
      await new CellControlRedirect({ directory: path.join(root, 'restored-endpoint', role), table,
        runner, verifyOwned, validateContext: restoredContext, makeSnapshot: value => restoredSnapshot(value, table) }).recover();
    }
    const routing = new CellRoutingCoordinator({ directory: path.join(root, 'routing-runtime'), runner,
      verifyInterfaces: async () => false }); // terminal deletion never creates or adopts a routing device
    try { await routing.guard.recover(); await routing.guard.protect(names); }
    catch (error) { throw new Error('Cell cleanup routing guard failed', { cause: error }); }
    const [nft, routes] = await Promise.all([routing.policy.load(), routing.routes.load()]);
    await routing.policy.reconcile(routing.policy.candidates(nft), null);
    const possible = [...new Map([...routes.committed, ...(routes.pending?.desired ?? [])]
      .map(command => [JSON.stringify(command), command])).values()];
    await routing.routes.reconcile(possible, []);
    for (const row of paths) {
      try { await row.runtime.remove(); }
      catch (error) { throw new Error(`Cell cleanup ${row.role} path failed`, { cause: error }); }
    }
    await new CellDockerTransit({ runner }).remove(names);
    await new CellDockerForwarding({ server: user.server, runner }).remove();
    await receipt.assertKnown();
    if (await runtime.tableExists()) await runner('nft', ['delete', 'table', 'inet', 'awg_easy_3']);
    if ((await links()).some(row => row.ifname === user.server.interfaceName)) {
      const stripped = await runtime.stripSavedConfig(user.server.interfaceName);
      if (!matchesAwgConfig(stripped.stdout, (await runner('awg', ['showconf', user.server.interfaceName])).stdout)) throw new Error('User interface changed during cleanup');
      await runner('ip', ['link', 'delete', 'dev', user.server.interfaceName]);
    }
    await routing.policy.save({ version: 1, committed: null, pending: null });
    await routing.routes.save({ version: 1, committed: [], pending: null });
    const removed = async () => !(await links()).some(row => names.includes(row.ifname))
      && await routing.policy.current() === null && !await runtime.tableExists();
    await routing.guard.release(removed); await guard.release(removed);
    return { removed: true };
  } });
}
module.exports = { cleanupCellOwnedResources };
