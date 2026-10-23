'use strict';

const net = require('node:net');
const { ipNumber } = require('./GeoIpAddress');
const { formatIPv6 } = require('./AddressAllocator');
const { privateAddress } = require('./CellTunnelControlTransport');

const CAPACITY = 127; // One controller plus at most 127 Cells in topology v1.
const ipv4 = number => [24n, 16n, 8n, 0n]
  .map(shift => Number((number >> shift) & 255n)).join('.');
function poolBase(value, family, prefix) {
  if (typeof value !== 'string') throw new TypeError('Data link address pool required');
  const [address, bits, extra] = value.split('/');
  if (extra !== undefined || bits !== String(prefix) || net.isIP(address) !== family
    || !privateAddress(address)) throw new TypeError('Invalid private data link address pool');
  const base = ipNumber(address), mask = BigInt((family === 4 ? 32 : 128) - prefix);
  if ((base >> mask) << mask !== base) throw new TypeError('Noncanonical data link address pool');
  return base;
}

// Pure allocator. The installer must additionally preflight the selected UDP
// port, interface name, host routes and overlaps with actual server subnets.
// Slots from any saved offer stay reserved even after temporary link loss.
function allocateCellDataLink({ usedSlots = [], unavailablePorts = [],
  pool4 = '10.252.0.0/23', pool6, portStart = 53000 } = {}) {
  const v4 = poolBase(pool4, 4, 23);
  const v6 = pool6 === undefined ? null : poolBase(pool6, 6, 112);
  if (!Number.isSafeInteger(portStart) || portStart < 1024
    || portStart + CAPACITY - 1 > 65535 || !Array.isArray(usedSlots)
    || usedSlots.some(value => !Number.isSafeInteger(value) || value < 0 || value >= CAPACITY)
    || new Set(usedSlots).size !== usedSlots.length || !Array.isArray(unavailablePorts)
    || unavailablePorts.some(value => !Number.isSafeInteger(value) || value < 1 || value > 65535)) {
    throw new TypeError('Invalid data link allocation inventory');
  }
  const used = new Set(usedSlots), ports = new Set(unavailablePorts);
  for (let slot = 0; slot < CAPACITY; slot++) {
    const endpointPort = portStart + slot;
    if (used.has(slot) || ports.has(endpointPort)) continue;
    const main = v4 + BigInt(4 * slot + 1), cell = main + 1n;
    return Object.freeze({ slot, endpointPort,
      controllerInterfaceName: `awgd${slot}`, cellInterfaceName: 'awgdata0',
      controllerAddress4: ipv4(main), cellAddress4: ipv4(cell),
      ...(v6 === null ? {} : { controllerAddress6: formatIPv6(v6 + BigInt(2 * slot + 1)),
        cellAddress6: formatIPv6(v6 + BigInt(2 * slot + 2)) }),
      controllerTable: 52000 + slot, controllerPriority: 20000 + slot,
      cellTable: 52000, cellPriority: 20000 });
  }
  throw new Error('No free Cell data link slot');
}

module.exports = { allocateCellDataLink, CAPACITY };
