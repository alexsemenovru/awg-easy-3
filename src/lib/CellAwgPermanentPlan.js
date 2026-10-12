'use strict';

const { createAwgOwnership, validateAwgOwnership } = require('./CellAwgOwnership');
const { matchesAwgConfig } = require('./CellAwgSnapshot');
const { renderPermanentServerConfig, renderPermanentCellConfig } = require('./CellAwgPermanentConfig');
const { permanentControlPolicySnapshot } = require('./CellAwgPermanentControlPolicy');
const { bootstrapServerRoutes, bootstrapCellRoutes } = require('./CellAwgBootstrapRoutes');

function ownerFor({ interfaceName, config, owner }) {
  if (!owner) return createAwgOwnership({ interfaceName, config });
  const saved = validateAwgOwnership(owner);
  if (saved.interfaceName !== interfaceName || !matchesAwgConfig(config, saved.config)
    || !matchesAwgConfig(saved.config, config)) {
    throw new Error('Persisted permanent AWG owner differs from the signed plan');
  }
  return saved;
}

// Create a plan once, persist its spec/ownerTag before touching the kernel,
// and reuse that exact owner on recovery. The endpoint must already be a
// chosen literal IP if the signed descriptor contains a DNS name.
function permanentCellPlan({ connection, interfaceName, resolvedEndpointHost, owner }) {
  const rendered = renderPermanentCellConfig(connection, resolvedEndpointHost);
  const descriptor = connection.controllerPath;
  return {
    spec: { version: 1, owner: ownerFor({ interfaceName, config: rendered.config, owner }),
      addresses: [rendered.address] },
    policy: permanentControlPolicySnapshot({ role: 'cell', interfaceName, descriptor }),
    routeCommands: bootstrapCellRoutes({ interfaceName,
      cellAddress: descriptor.cellAddress, controllerAddress: descriptor.controllerAddress }),
  };
}

async function permanentControllerPlan({ privateKey, descriptor, peers, interfaceName,
  keyManager, owner }) {
  if (!Array.isArray(peers)) throw new TypeError('Permanent AWG peers required');
  const orderedPeers = [...peers].sort((a, b) =>
    String(a?.awgPublicKey).localeCompare(String(b?.awgPublicKey)));
  const rendered = await renderPermanentServerConfig({ privateKey, descriptor,
    peers: orderedPeers, ...(keyManager ? { keyManager } : {}) });
  if (!orderedPeers.some(peer => peer.cellAddress === descriptor.cellAddress)) {
    throw new TypeError('Signed cell address is absent from permanent AWG peers');
  }
  return {
    spec: { version: 1, owner: ownerFor({ interfaceName, config: rendered.config, owner }),
      addresses: [rendered.address] },
    policy: permanentControlPolicySnapshot({ role: 'controller', interfaceName,
      descriptor, peerAddresses: orderedPeers.map(peer => peer.cellAddress) }),
    routeCommands: bootstrapServerRoutes({ interfaceName,
      controllerAddress: descriptor.controllerAddress,
      peers: orderedPeers.map(peer => ({ phase: 'ready', cellAddress: peer.cellAddress })) }),
  };
}

module.exports = { permanentCellPlan, permanentControllerPlan };
