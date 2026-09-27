'use strict';

const net = require('node:net');
const { validateKey } = require('./AwgKeyManager');
const { renderInterfaceFields } = require('./Awg3Config');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { decodeAwgBootstrapInvitation } = require('./CellAwgBootstrapInvitation');
const { privateAddress } = require('./CellTunnelControlTransport');

function internalAddress(address) {
  return privateAddress(address) && !address.startsWith('127.') && address !== '::1';
}

function cidr(address) {
  return `${address}/${net.isIP(address) === 4 ? 32 : 128}`;
}

function endpoint(host, port) {
  return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

// Deliberately stripped `awg setconf` configuration: addresses and firewall
// rules are owned by separate lifecycle/guard steps, never config hooks.
function renderBootstrapServerConfig({ privateKey, listenPort, controllerAddress,
  profile, peers }) {
  validateKey(privateKey, 'bootstrapServerPrivateKey');
  if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65535
    || !internalAddress(controllerAddress) || !Array.isArray(peers) || peers.length > 128) {
    throw new TypeError('Invalid bootstrap server configuration');
  }
  const usedKeys = new Set(), usedAddresses = new Set();
  const blocks = peers.map(peer => {
    if (!peer || !['pending', 'ready', 'consumed'].includes(peer.status)
      || !internalAddress(peer.cellAddress)
      || net.isIP(peer.cellAddress) !== net.isIP(controllerAddress)
      || peer.cellAddress === controllerAddress
      || usedKeys.has(peer.temporaryPublicKey) || usedAddresses.has(peer.cellAddress)) {
      throw new TypeError('Invalid or duplicate bootstrap peer');
    }
    validateKey(peer.temporaryPublicKey, 'temporaryPublicKey');
    validateKey(peer.temporaryPresharedKey, 'temporaryPresharedKey');
    usedKeys.add(peer.temporaryPublicKey); usedAddresses.add(peer.cellAddress);
    return { key: peer.temporaryPublicKey,
      text: `[Peer]\nPublicKey = ${peer.temporaryPublicKey}\nPresharedKey = ${peer.temporaryPresharedKey}\nAllowedIPs = ${cidr(peer.cellAddress)}` };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const config = `[Interface]\nPrivateKey = ${privateKey}\nListenPort = ${listenPort}\n${renderInterfaceFields(profile)}\n`
    + blocks.map(peer => `\n${peer.text}\n`).join('');
  normalizeAwgConfig(config);
  return config;
}

function renderBootstrapCellConfig(code, now = Date.now()) {
  const invite = decodeAwgBootstrapInvitation(code, now);
  const config = `[Interface]\nPrivateKey = ${invite.temporaryPrivateKey}\n${renderInterfaceFields(invite.profile)}\n`
    + `\n[Peer]\nPublicKey = ${invite.serverPublicKey}\nPresharedKey = ${invite.temporaryPresharedKey}\n`
    + `AllowedIPs = ${cidr(invite.controllerAddress)}\nEndpoint = ${endpoint(invite.endpointHost, invite.endpointPort)}\n`;
  // Snapshot parser currently accepts literal endpoints only. A DNS endpoint
  // is valid for live AWG, so validate the rest against an endpoint-free copy.
  normalizeAwgConfig(config.replace(/^Endpoint = .*\n/m, ''));
  return { config, address: cidr(invite.cellAddress),
    controllerAddress: invite.controllerAddress, registrationPort: invite.registrationPort };
}

module.exports = { renderBootstrapServerConfig, renderBootstrapCellConfig };
