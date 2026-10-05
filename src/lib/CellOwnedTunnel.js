'use strict';

const net = require('node:net');
const { ipNumber } = require('./GeoIpAddress');
const { privateAddress } = require('./CellTunnelControlTransport');

// A private literal address alone is not proof of an owned AWG tunnel. The
// lifecycle journal and exact kernel readback must both confirm the bind IP.
async function requireOwnedTunnelAddress({ lifecycle, address }) {
  if (!lifecycle || typeof lifecycle.load !== 'function' || typeof lifecycle.verify !== 'function') {
    throw new TypeError('Owned AWG lifecycle required for tunnel listener');
  }
  if (!privateAddress(address)) throw new TypeError('Tunnel listener requires a private address');
  const saved = await lifecycle.load();
  if (saved.phase !== 'ready' || !saved.spec?.owner?.interfaceName
    || !Array.isArray(saved.spec.addresses)) {
    throw new Error('Owned AWG device is not ready');
  }
  const family = net.isIP(address);
  if (!saved.spec.addresses.some(value => {
    const host = value.split('/')[0];
    return net.isIP(host) === family && ipNumber(host) === ipNumber(address);
  })) throw new Error('Tunnel bind address is not owned by AWG');
  if (!(await lifecycle.verify(saved.spec)).up) throw new Error('Owned AWG device is down');
  return saved.spec;
}

module.exports = { requireOwnedTunnelAddress };
