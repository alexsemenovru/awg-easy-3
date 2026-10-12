'use strict';

const net = require('node:net');
const { validateKey } = require('./AwgKeyManager');
const { validateProfile } = require('./Awg3Config');
const { privateAddress } = require('./CellTunnelControlTransport');
const { validEndpointHost } = require('./CellAwgEndpointHost');

function validatePermanentDescriptor(value) {
  const fields = ['version', 'endpointHost', 'endpointPort', 'controllerAddress',
    'cellAddress', 'controlPort', 'serverPublicKey', 'profile'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== fields.sort().join(',')
    || value.version !== 1 || !validEndpointHost(value.endpointHost)
    || ![value.endpointPort, value.controlPort].every(port =>
      Number.isSafeInteger(port) && port >= 1 && port <= 65535)
    || !privateAddress(value.controllerAddress) || !privateAddress(value.cellAddress)
    || value.controllerAddress.startsWith('127.') || value.cellAddress.startsWith('127.')
    || value.controllerAddress === '::1' || value.cellAddress === '::1'
    || net.isIP(value.controllerAddress) !== net.isIP(value.cellAddress)
    || value.controllerAddress === value.cellAddress) {
    throw new TypeError('Invalid permanent AWG descriptor');
  }
  validateKey(value.serverPublicKey, 'serverPublicKey');
  const profile = validateProfile(value.profile);
  if (Object.keys(profile).sort().join(',') !== Object.keys(value.profile).sort().join(',')) {
    throw new TypeError('Invalid permanent AWG profile');
  }
  return Object.freeze({ version: 1, endpointHost: value.endpointHost,
    endpointPort: value.endpointPort, controllerAddress: value.controllerAddress,
    cellAddress: value.cellAddress, controlPort: value.controlPort,
    serverPublicKey: value.serverPublicKey, profile });
}

function permanentControllerIdentity(value) {
  const descriptor = validatePermanentDescriptor(value);
  const profile = Object.fromEntries(Object.keys(descriptor.profile).sort()
    .map(key => [key, descriptor.profile[key]]));
  return JSON.stringify([descriptor.endpointHost, descriptor.endpointPort,
    descriptor.controllerAddress, descriptor.controlPort,
    descriptor.serverPublicKey, profile]);
}

module.exports = { validatePermanentDescriptor, permanentControllerIdentity };
