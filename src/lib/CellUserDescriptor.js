'use strict';

const net = require('node:net');
const { validEndpointHost } = require('./CellAwgEndpointHost');
const { validateProfile } = require('./Awg3Config');
const { addressInSubnet } = require('./AddressAllocator');

const vpnKey = value => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)
  && Buffer.from(value, 'base64').length === 32
  && Buffer.from(value, 'base64').toString('base64') === value;

// Public, non-secret parameters needed to render a client profile for this
// Cell. The Cell identity signs the announcement over the private AWG path.
function validateCellUserDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['version', 'endpointHost', 'endpointPort',
      'serverPublicKey', 'address4', 'ipv4Subnet', 'address6', 'ipv6Subnet', 'profile'].includes(key))
    || value.version !== 1 || !validEndpointHost(value.endpointHost)
    || !Number.isSafeInteger(value.endpointPort) || value.endpointPort < 1
    || value.endpointPort > 65535 || !vpnKey(value.serverPublicKey)
    || net.isIP(value.address4) !== 4 || typeof value.ipv4Subnet !== 'string'
    || !addressInSubnet(value.address4, value.ipv4Subnet)
    || (Object.hasOwn(value, 'address6') !== Object.hasOwn(value, 'ipv6Subnet'))
    || (value.address6 !== undefined && (net.isIP(value.address6) !== 6
      || typeof value.ipv6Subnet !== 'string'
      || !addressInSubnet(value.address6, value.ipv6Subnet)))) {
    throw new TypeError('Invalid Cell user descriptor');
  }
  const profile = validateProfile(value.profile);
  return Object.freeze({ ...value, profile });
}

module.exports = { validateCellUserDescriptor };
