'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');
const { decodeAwgBootstrapInvitation } = require('./CellAwgBootstrapInvitation');
const { renderBootstrapCellConfig } = require('./CellAwgBootstrapConfig');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { createAwgOwnership } = require('./CellAwgOwnership');

function usableEndpoint(host) {
  const family = net.isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number);
    return a !== 0 && a !== 127 && a < 224 && !(a === 169 && b === 254);
  }
  return family === 6 && host !== '::' && host !== '::1'
    && !/^f[ef]/i.test(host) && !/^fe[89ab]/i.test(host);
}

// Resolve the signed DNS endpoint once before creating a journaled AWG device.
// The server's signed AWG public key still authenticates the actual endpoint.
async function prepareBootstrapCellDevice({ code, interfaceName, now = Date.now(),
  resolve = host => dns.lookup(host, { all: true }), mtu = 1280 }) {
  const invitation = decodeAwgBootstrapInvitation(code, now);
  const rendered = renderBootstrapCellConfig(code, now);
  let host = invitation.endpointHost;
  if (!net.isIP(host)) {
    let answers;
    try { answers = await resolve(host); }
    catch { throw new Error('Bootstrap endpoint resolution failed'); }
    if (!Array.isArray(answers)) throw new Error('Invalid bootstrap DNS response');
    host = answers.map(answer => answer?.address).find(usableEndpoint);
    if (!host) throw new Error('No usable bootstrap endpoint address');
  }
  if (!usableEndpoint(host)) throw new Error('Invalid bootstrap endpoint address');
  const endpoint = `${net.isIP(host) === 6 ? `[${host}]` : host}:${invitation.endpointPort}`;
  const config = rendered.config.replace(/^Endpoint = .*$/m, `Endpoint = ${endpoint}`);
  normalizeAwgConfig(config);
  return { spec: { version: 1,
    owner: createAwgOwnership({ interfaceName, config, mtu }),
    addresses: [rendered.address] },
  controllerAddress: rendered.controllerAddress,
  registrationPort: rendered.registrationPort,
  resolvedEndpoint: endpoint };
}

module.exports = { prepareBootstrapCellDevice };
