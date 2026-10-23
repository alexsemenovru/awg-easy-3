'use strict';

const { validateDataLinkDescriptor } = require('./CellDataLinkConfig');
const { specification } = require('./CellRoutingCoordinator');

// A signed offer, an AWG interface, and even a fresh handshake are each
// insufficient to advertise a usable client path. Both durable guards must
// be gone and the exact user-routing revision must still read back intact.
async function verifiedCellDataLink({ cellId, descriptor, dataPath, routing,
  routingSpec, verifyHandshake } = {}) {
  if (typeof cellId !== 'string' || !/^[a-f0-9]{32}$/.test(cellId)
    || !dataPath || typeof dataPath.verifyOperational !== 'function'
    || !routing || typeof routing.verifyOperational !== 'function'
    || typeof verifyHandshake !== 'function') {
    throw new TypeError('Complete Cell data link verifier required');
  }
  const link = validateDataLinkDescriptor(descriptor);
  const desired = specification(routingSpec);
  if (!desired.interfaces.includes(dataPath.interfaceName)) {
    throw new TypeError('Routing revision omits the data interface');
  }
  if (!await dataPath.verifyOperational()
    || !await routing.verifyOperational(desired)
    || await verifyHandshake() !== true) return null;
  return Object.freeze({ cellId, ipv4: true, ipv6: Boolean(link.cellAddress6) });
}

module.exports = { verifiedCellDataLink };
