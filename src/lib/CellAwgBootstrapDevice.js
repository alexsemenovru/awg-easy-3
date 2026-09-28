'use strict';

const net = require('node:net');
const { runProcess } = require('./ProcessRunner');
const { createAwgOwnership } = require('./CellAwgOwnership');
const { renderBootstrapServerConfig } = require('./CellAwgBootstrapConfig');
const { privateAddress } = require('./CellTunnelControlTransport');

const validName = name => typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,15}$/.test(name);
const validPort = port => Number.isSafeInteger(port) && port >= 1 && port <= 65535;

// This is a preflight, not a reservation. The lifecycle still refuses an
// existing interface, and setconf must prove that the requested port bound.
async function inspectBootstrapConflicts({ interfaceName, listenPort, userInterfaces = [],
  userUdpPorts = [], runner = runProcess }) {
  if (!validName(interfaceName) || !validPort(listenPort)
    || !Array.isArray(userInterfaces) || userInterfaces.some(name => !validName(name))
    || !Array.isArray(userUdpPorts) || userUdpPorts.some(port => !validPort(port))
    || typeof runner !== 'function') throw new TypeError('Invalid bootstrap preflight');
  if (userInterfaces.includes(interfaceName)) throw new Error('Bootstrap interface overlaps a user interface');
  if (userUdpPorts.includes(listenPort)) throw new Error('Bootstrap UDP port overlaps a user port');

  let links, sockets;
  try {
    links = JSON.parse((await runner('ip', ['-j', 'link', 'show'])).stdout);
    // UDP ports may be held by connected sockets, not only listeners.
    sockets = (await runner('ss', ['-H', '-n', '-u', '-a'])).stdout;
  } catch { throw new Error('Bootstrap host inventory unavailable'); }
  if (!Array.isArray(links) || links.some(link => !link || typeof link.ifname !== 'string')
    || typeof sockets !== 'string') throw new Error('Invalid bootstrap host inventory');
  if (links.some(link => link.ifname === interfaceName)) throw new Error('Bootstrap interface name already exists');
  const lines = sockets.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || !['UNCONN', 'UNCONN-RECV', 'ESTAB', 'CONNECTED'].includes(fields[0])) {
      throw new Error('Invalid UDP socket inventory');
    }
    const match = /:(\d+)$/.exec(fields[3]);
    if (!match || !validPort(Number(match[1]))) throw new Error('Invalid UDP socket inventory');
    if (Number(match[1]) === listenPort) throw new Error('Bootstrap UDP port already in use');
  }
  return { interfaceAvailable: true, udpPortAvailable: true };
}

async function prepareBootstrapDevice({ interfaceName, listenPort, controllerAddress,
  privateKey, profile, mtu = 1280, userInterfaces = [], userUdpPorts = [],
  runner = runProcess }) {
  if (!privateAddress(controllerAddress) || controllerAddress.startsWith('127.')
    || controllerAddress === '::1') throw new TypeError('Invalid bootstrap controller address');
  await inspectBootstrapConflicts({ interfaceName, listenPort, userInterfaces,
    userUdpPorts, runner });
  const config = renderBootstrapServerConfig({ privateKey, listenPort,
    controllerAddress, profile, peers: [] });
  return { version: 1, owner: createAwgOwnership({ interfaceName, config, mtu }),
    addresses: [`${controllerAddress}/${net.isIP(controllerAddress) === 4 ? 32 : 128}`] };
}

module.exports = { inspectBootstrapConflicts, prepareBootstrapDevice };
