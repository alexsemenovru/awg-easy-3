'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');
const path = require('node:path');
const { runProcess } = require('./ProcessRunner');
const { validEndpointHost } = require('./CellAwgEndpointHost');
const { CellAwgPermanentDeployment } = require('./CellAwgPermanentDeployment');
const { CellAwgPermanentRetirementGate } = require('./CellAwgPermanentRetirementGate');
const { CellAwgBootstrapCellRetirement } = require('./CellAwgBootstrapCellRetirement');
const { joinPermanentCell } = require('./CellAwgPermanentJoin');
const { withCellInstallationLock } = require('./CellInstallationLock');

// This stage does not start a user-facing Cell service. It moves one signed
// registration to an owned permanent AWG path and retires bootstrap only after
// the permanent path proves operational.
function openCellPermanentJoinHost({ stateDirectory, interfaceName,
  temporaryInterfaceName, connectionStore, bootstrap,
  runner = runProcess, withLock = withCellInstallationLock,
  resolve = host => dns.lookup(host, { all: true }),
  join = joinPermanentCell,
  makeDeployment = options => new CellAwgPermanentDeployment(options) } = {}) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || ![interfaceName, temporaryInterfaceName].every(name =>
      typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,15}$/.test(name))
    || interfaceName === temporaryInterfaceName
    || !connectionStore || typeof connectionStore.read !== 'function'
    || !bootstrap || !['lifecycle', 'awg', 'firewall', 'routes', 'guard']
      .every(name => bootstrap[name])
    || typeof runner !== 'function' || typeof withLock !== 'function'
    || typeof resolve !== 'function' || typeof join !== 'function'
    || typeof makeDeployment !== 'function') {
    throw new TypeError('Permanent Cell join dependencies required');
  }
  const deployment = makeDeployment({
    stateDirectory: path.join(stateDirectory, 'permanent'), runner });
  const gate = new CellAwgPermanentRetirementGate({ deployment });
  const retirement = new CellAwgBootstrapCellRetirement({
    connection: connectionStore, ...bootstrap,
    interfaceName: temporaryInterfaceName,
    verifyPermanent: connection => gate.verifyCell(connection),
  });
  return Object.freeze({
    join: () => withLock({ lockPath: path.join(stateDirectory, 'install.lock'),
      work: async () => {
        const connection = await connectionStore.read();
        if (connection?.status !== 'registered' || !connection.controllerPath) {
          throw new Error('Signed permanent Cell registration required');
        }
        // A previously reserved plan pins its literal endpoint; never resolve
        // DNS again during recovery and accidentally change the owner.
        let host;
        if (!await deployment.store.read()) {
          host = connection.controllerPath.endpointHost;
          if (!net.isIP(host)) {
            let answers;
            try { answers = await resolve(host); }
            catch { throw new Error('Permanent Cell endpoint resolution failed'); }
            if (!Array.isArray(answers)) throw new Error('Invalid permanent Cell DNS response');
            host = answers.map(answer => answer?.address)
              .find(address => net.isIP(address) && validEndpointHost(address));
          }
          if (!net.isIP(host) || !validEndpointHost(host)) {
            throw new Error('No usable permanent Cell endpoint address');
          }
        }
        return join({ connectionStore, deployment, gate, retirement,
          interfaceName, ...(host ? { resolvedEndpointHost: host } : {}) });
      } }),
  });
}

module.exports = { openCellPermanentJoinHost };
