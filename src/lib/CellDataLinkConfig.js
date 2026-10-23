'use strict';

const net = require('node:net');
const { AwgKeyManager, validateKey } = require('./AwgKeyManager');
const { renderInterfaceFields, validateProfile } = require('./Awg3Config');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { validEndpointHost } = require('./CellAwgEndpointHost');
const { privateAddress } = require('./CellTunnelControlTransport');
const { addressInSubnet } = require('./AddressAllocator');
const { ipNumber } = require('./GeoIpAddress');

const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const host = value => privateAddress(value) && !value.startsWith('127.') && value !== '::1';
const cidr = value => `${value}/${net.isIP(value) === 4 ? 32 : 128}`;

function canonicalSubnet(value, family) {
  if (typeof value !== 'string') throw new TypeError('Data link subnet required');
  const [address, prefix, extra] = value.split('/');
  const bits = family === 4 ? 32 : 128;
  if (extra !== undefined || net.isIP(address) !== family || address.includes('%')
    || !/^(0|[1-9][0-9]*)$/.test(prefix) || Number(prefix) > bits) {
    throw new TypeError('Invalid data link subnet');
  }
  const mask = BigInt(bits - Number(prefix));
  if ((ipNumber(address) >> mask) << mask !== ipNumber(address)) {
    throw new TypeError('Noncanonical data link subnet');
  }
  return value;
}

// Public descriptor intended for a signed Main Node settings revision.
// Validation alone is not authentication. The control AWG path never doubles
// as a client traffic path.
function validateDataLinkDescriptor(value) {
  const required = ['version', 'endpointHost', 'endpointPort', 'controllerAddress4',
    'cellAddress4', 'controllerPublicKey', 'controllerClientSubnet4',
    'cellClientSubnet4', 'profile'];
  const optional = ['controllerAddress6', 'cellAddress6', 'controllerClientSubnet6',
    'cellClientSubnet6', 'slot'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
    || value.version !== 1 || !validEndpointHost(value.endpointHost)
    || !Number.isSafeInteger(value.endpointPort) || value.endpointPort < 1
    || value.endpointPort > 65535 || !host(value.controllerAddress4)
    || (value.slot !== undefined && (!Number.isSafeInteger(value.slot)
      || value.slot < 0 || value.slot > 126))
    || !host(value.cellAddress4) || net.isIP(value.controllerAddress4) !== 4
    || net.isIP(value.cellAddress4) !== 4
    || value.controllerAddress4 === value.cellAddress4) {
    throw new TypeError('Invalid data link descriptor');
  }
  validateKey(value.controllerPublicKey, 'dataControllerPublicKey');
  const ipv6Fields = optional.filter(key => key !== 'slot');
  const has6 = ipv6Fields.some(key => Object.hasOwn(value, key));
  if (has6 && ipv6Fields.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError('Incomplete IPv6 data link descriptor');
  }
  if (has6 && (!host(value.controllerAddress6) || !host(value.cellAddress6)
    || net.isIP(value.controllerAddress6) !== 6 || net.isIP(value.cellAddress6) !== 6
    || ipNumber(value.controllerAddress6) === ipNumber(value.cellAddress6))) {
    throw new TypeError('Invalid IPv6 data link addresses');
  }
  const controllerClientSubnet4 = canonicalSubnet(value.controllerClientSubnet4, 4);
  const cellClientSubnet4 = canonicalSubnet(value.cellClientSubnet4, 4);
  const controllerClientSubnet6 = has6 ? canonicalSubnet(value.controllerClientSubnet6, 6) : undefined;
  const cellClientSubnet6 = has6 ? canonicalSubnet(value.cellClientSubnet6, 6) : undefined;
  for (const [family, mainSubnet, cellSubnet, mainAddress, cellAddress] of [
    [4, controllerClientSubnet4, cellClientSubnet4, value.controllerAddress4, value.cellAddress4],
    ...(has6 ? [[6, controllerClientSubnet6, cellClientSubnet6,
      value.controllerAddress6, value.cellAddress6]] : []),
  ]) {
    if (addressInSubnet(mainAddress, mainSubnet) || addressInSubnet(mainAddress, cellSubnet)
      || addressInSubnet(cellAddress, mainSubnet) || addressInSubnet(cellAddress, cellSubnet)
      || addressInSubnet(mainSubnet.split('/')[0], cellSubnet)
      || addressInSubnet(cellSubnet.split('/')[0], mainSubnet)) {
      throw new TypeError(`IPv${family} data and client networks overlap`);
    }
  }
  const profile = validateProfile(value.profile);
  if (!exact(value.profile, Object.keys(profile))) throw new TypeError('Invalid data link profile fields');
  return Object.freeze({ ...value, profile });
}

async function renderDataControllerConfig({ privateKey, descriptor, cellPublicKey,
  presharedKey, keyManager = new AwgKeyManager() } = {}) {
  const link = validateDataLinkDescriptor(descriptor);
  validateKey(privateKey, 'dataControllerPrivateKey');
  validateKey(cellPublicKey, 'dataCellPublicKey');
  validateKey(presharedKey, 'dataPresharedKey');
  if (!keyManager || typeof keyManager.derivePublicKey !== 'function'
    || await keyManager.derivePublicKey(privateKey) !== link.controllerPublicKey
    || cellPublicKey === link.controllerPublicKey) {
    throw new TypeError('Data link identity mismatch');
  }
  const allowed = [cidr(link.cellAddress4), link.cellClientSubnet4,
    ...(link.cellAddress6 ? [cidr(link.cellAddress6), link.cellClientSubnet6] : [])];
  const config = `[Interface]\nPrivateKey = ${privateKey}\nListenPort = ${link.endpointPort}\n`
    + `${renderInterfaceFields(link.profile)}\n\n[Peer]\nPublicKey = ${cellPublicKey}\n`
    + `PresharedKey = ${presharedKey}\nAllowedIPs = ${allowed.join(', ')}\n`;
  normalizeAwgConfig(config);
  return Object.freeze({ config, addresses: [cidr(link.controllerAddress4),
    ...(link.controllerAddress6 ? [cidr(link.controllerAddress6)] : [])] });
}

function renderDataCellConfig({ privateKey, descriptor, presharedKey,
  remoteExit4 = false, remoteExit6 = false } = {}) {
  const link = validateDataLinkDescriptor(descriptor);
  validateKey(privateKey, 'dataCellPrivateKey');
  validateKey(presharedKey, 'dataPresharedKey');
  if (typeof remoteExit4 !== 'boolean' || typeof remoteExit6 !== 'boolean'
    || (remoteExit6 && !link.cellAddress6)) throw new TypeError('Invalid remote exit capabilities');
  const allowed = [cidr(link.controllerAddress4),
    remoteExit4 ? '0.0.0.0/0' : link.controllerClientSubnet4,
    ...(link.cellAddress6 ? [cidr(link.controllerAddress6),
      remoteExit6 ? '::/0' : link.controllerClientSubnet6] : [])];
  const endpoint = `${net.isIP(link.endpointHost) === 6 ? `[${link.endpointHost}]` : link.endpointHost}:${link.endpointPort}`;
  const config = `[Interface]\nPrivateKey = ${privateKey}\n${renderInterfaceFields(link.profile)}\n`
    + `\n[Peer]\nPublicKey = ${link.controllerPublicKey}\nPresharedKey = ${presharedKey}\n`
    + `AllowedIPs = ${allowed.join(', ')}\nEndpoint = ${endpoint}\nPersistentKeepalive = 5\n`;
  // Only the endpoint is allowed to be DNS here. The caller must pin a
  // resolved literal before creating an owned AWG lifecycle specification.
  normalizeAwgConfig(config.replace(/^Endpoint = .*\n/m, ''));
  return Object.freeze({ config, addresses: [cidr(link.cellAddress4),
    ...(link.cellAddress6 ? [cidr(link.cellAddress6)] : [])] });
}

module.exports = { validateDataLinkDescriptor, renderDataControllerConfig,
  renderDataCellConfig };
