'use strict';

const net = require('node:net');
const { AwgKeyManager, validateKey } = require('./AwgKeyManager');
const { renderInterfaceFields } = require('./Awg3Config');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { validatePermanentDescriptor } = require('./CellAwgPermanentDescriptor');
const { validEndpointHost } = require('./CellAwgEndpointHost');
const { privateAddress } = require('./CellTunnelControlTransport');

const cidr = address => `${address}/${net.isIP(address) === 4 ? 32 : 128}`;
const endpoint = (host, port) => `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;

// The controller may serve many cells on one owned AWG interface. Its
// private key never appears in a registration receipt or a cell store.
async function renderPermanentServerConfig({ privateKey, descriptor, peers,
  keyManager = new AwgKeyManager() }) {
  const path = validatePermanentDescriptor(descriptor);
  validateKey(privateKey, 'permanentServerPrivateKey');
  if (!keyManager || typeof keyManager.derivePublicKey !== 'function'
    || await keyManager.derivePublicKey(privateKey) !== path.serverPublicKey
    || !Array.isArray(peers) || peers.length > 128) {
    throw new TypeError('Invalid permanent server identity or peers');
  }
  const keys = new Set(), addresses = new Set();
  const blocks = peers.map(peer => {
    if (!peer || !privateAddress(peer.cellAddress)
      || peer.cellAddress.startsWith('127.') || peer.cellAddress === '::1'
      || net.isIP(peer.cellAddress) !== net.isIP(path.controllerAddress)
      || peer.cellAddress === path.controllerAddress
      || addresses.has(peer.cellAddress) || keys.has(peer.awgPublicKey)) {
      throw new TypeError('Invalid or duplicate permanent AWG peer');
    }
    validateKey(peer.awgPublicKey, 'cellAwgPublicKey');
    validateKey(peer.awgPresharedKey, 'cellAwgPresharedKey');
    addresses.add(peer.cellAddress); keys.add(peer.awgPublicKey);
    return { key: peer.awgPublicKey,
      text: `\n[Peer]\nPublicKey = ${peer.awgPublicKey}\nPresharedKey = ${peer.awgPresharedKey}\n`
        + `AllowedIPs = ${cidr(peer.cellAddress)}\n` };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const config = `[Interface]\nPrivateKey = ${privateKey}\nListenPort = ${path.endpointPort}\n`
    + `${renderInterfaceFields(path.profile)}\n` + blocks.map(block => block.text).join('');
  normalizeAwgConfig(config);
  return { config, address: cidr(path.controllerAddress) };
}

// The cell uses its own durable private key/PSK and only the signed controller
// descriptor. No temporary invitation secret is needed after registration.
function renderPermanentCellConfig(connection, resolvedEndpointHost) {
  if (!connection || connection.status !== 'registered' || !connection.permanent
    || !connection.controllerPath) throw new TypeError('Registered permanent cell path required');
  const path = validatePermanentDescriptor(connection.controllerPath);
  // AWG ownership/readback accepts literal endpoints only. A DNS name in the
  // signed descriptor must be resolved and the chosen address persisted by
  // the caller before a lifecycle manifest is created.
  const host = resolvedEndpointHost ?? path.endpointHost;
  if (!net.isIP(host) || !validEndpointHost(host)) {
    throw new TypeError('Literal permanent AWG endpoint required');
  }
  validateKey(connection.permanent.privateKey, 'cellPrivateKey');
  validateKey(connection.permanent.presharedKey, 'cellPresharedKey');
  const config = `[Interface]\nPrivateKey = ${connection.permanent.privateKey}\n`
    + `${renderInterfaceFields(path.profile)}\n`
    + `\n[Peer]\nPublicKey = ${path.serverPublicKey}\n`
    + `PresharedKey = ${connection.permanent.presharedKey}\n`
    + `AllowedIPs = ${cidr(path.controllerAddress)}\n`
    + `Endpoint = ${endpoint(host, path.endpointPort)}\n`
    + `PersistentKeepalive = 5\n`;
  normalizeAwgConfig(config);
  return { config, address: cidr(path.cellAddress), controllerAddress: path.controllerAddress,
    controlPort: path.controlPort, endpointHost: host };
}

module.exports = { renderPermanentServerConfig, renderPermanentCellConfig };
