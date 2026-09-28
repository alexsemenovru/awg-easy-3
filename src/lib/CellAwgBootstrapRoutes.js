'use strict';

const net = require('node:net');
const { privateAddress } = require('./CellTunnelControlTransport');
const { manifest } = require('./CellRouteOwnership');

const iface = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,15}$/.test(value);
const address = value => privateAddress(value) && !value.startsWith('127.') && value !== '::1';
function command(destination, interfaceName) {
  const family = net.isIP(destination);
  return { file: 'ip', args: [`-${family}`, 'route', 'add',
    `${destination}/${family === 4 ? 32 : 128}`, 'table', 'main',
    'proto', '186', 'dev', interfaceName] };
}

function bootstrapServerRoutes({ interfaceName, controllerAddress, peers }) {
  if (!iface(interfaceName) || !address(controllerAddress) || !Array.isArray(peers)
    || peers.length > 128) throw new TypeError('Invalid bootstrap server routes');
  const active = peers.filter(peer => ['preparing', 'ready'].includes(peer?.phase));
  const addresses = active.map(peer => peer.cellAddress);
  if (addresses.some(value => !address(value) || net.isIP(value) !== net.isIP(controllerAddress)
    || value === controllerAddress) || new Set(addresses).size !== addresses.length) {
    throw new TypeError('Invalid bootstrap peer route');
  }
  return manifest(addresses.sort().map(value => command(value, interfaceName)))
    .map(item => item.command);
}

function bootstrapCellRoutes({ interfaceName, cellAddress, controllerAddress }) {
  if (!iface(interfaceName) || !address(cellAddress) || !address(controllerAddress)
    || net.isIP(cellAddress) !== net.isIP(controllerAddress)
    || cellAddress === controllerAddress) throw new TypeError('Invalid bootstrap cell route');
  return manifest([command(controllerAddress, interfaceName)]).map(item => item.command);
}

module.exports = { bootstrapServerRoutes, bootstrapCellRoutes };
