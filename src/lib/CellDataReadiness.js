'use strict';

const { validateDataLinkDescriptor } = require('./CellDataLinkConfig');
const { specification } = require('./CellRoutingCoordinator');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { AwgKeyManager } = require('./AwgKeyManager');
const { formatIPv6 } = require('./AddressAllocator');
const { ipNumber } = require('./GeoIpAddress');

// A signed offer, an AWG interface, and even a fresh handshake are each
// insufficient to advertise a usable client path. Both durable guards must
// be gone and the exact user-routing revision must still read back intact.
async function verifiedCellDataLink({ cellId, descriptor, role, dataPath, routing,
  routingSpec, verifyHandshake, keyManager = new AwgKeyManager() } = {}) {
  if (typeof cellId !== 'string' || !/^[a-f0-9]{32}$/.test(cellId)
    || !['main', 'cell'].includes(role)
    || !dataPath || typeof dataPath.verifyOperational !== 'function'
    || !routing || typeof routing.verifyOperational !== 'function'
    || typeof verifyHandshake !== 'function'
    || !keyManager || typeof keyManager.derivePublicKey !== 'function') {
    throw new TypeError('Complete Cell data link verifier required');
  }
  const link = validateDataLinkDescriptor(descriptor);
  const desired = specification(routingSpec);
  if (!desired.interfaces.includes(dataPath.interfaceName)) {
    throw new TypeError('Routing revision omits the data interface');
  }
  const expectedName = role === 'main' ? `awgd${link.slot}` : 'awgdata0';
  const local4 = role === 'main' ? link.controllerAddress4 : link.cellAddress4;
  const local6 = role === 'main' ? link.controllerAddress6 : link.cellAddress6;
  const addresses = [`${local4}/32`, ...(local6
    ? [`${formatIPv6(ipNumber(local6))}/128`] : [])].sort();
  if (link.slot === undefined || dataPath.interfaceName !== expectedName
    || !dataPath.spec?.owner?.config
    || JSON.stringify(dataPath.spec.addresses) !== JSON.stringify(addresses)) return null;
  const config = normalizeAwgConfig(dataPath.spec.owner.config);
  const controllerKey = role === 'main'
    ? await keyManager.derivePublicKey(config.interface.privatekey)
    : config.peers[0]?.publickey;
  if (controllerKey !== link.controllerPublicKey) return null;
  if (!await dataPath.verifyOperational()
    || !await routing.verifyOperational(desired)
    || await verifyHandshake() !== true) return null;
  return Object.freeze({ cellId, ipv4: true, ipv6: Boolean(link.cellAddress6) });
}

module.exports = { verifiedCellDataLink };
