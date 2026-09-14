'use strict';

const net = require('node:net');
const { ipNumber } = require('./GeoIpAddress');
const { validateCellSettings } = require('./CellSettingsSchema');
const { renderServerConfig } = require('./AwgConfigRenderer');
const { renderNftablesPolicy } = require('./NftablesPolicy');

function subnet(cidr, address, family) {
  if (typeof cidr !== 'string') throw new TypeError('Cell subnet required');
  const [base, prefixText, extra] = cidr.split('/');
  const bits = family === 4 ? 32 : 128;
  if (extra !== undefined || net.isIP(base) !== family || !/^[1-9][0-9]*$/.test(prefixText)
    || Number(prefixText) > bits || net.isIP(address) !== family) throw new TypeError('Invalid cell subnet');
  const shift = BigInt(bits - Number(prefixText));
  const start = (ipNumber(base) >> shift) << shift;
  if (ipNumber(base) !== start || (ipNumber(address) >> shift) !== (start >> shift)) {
    throw new TypeError('Cell address must belong to canonical subnet');
  }
  return { prefix: Number(prefixText), start, end: start + (1n << shift) - 1n,
    server: ipNumber(address), shift };
}

// Local-entry/local-exit compiler only; inter-server routing is a separate stage.
function buildCellArtifacts({ server, settings, geoDatabase = {} }) {
  const normalized = validateCellSettings(settings);
  if (!server || server.interfaceName === server.wanInterface) throw new TypeError('Invalid cell interfaces');
  if (typeof server.privateKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(server.privateKey)
    || Buffer.from(server.privateKey, 'base64').toString('base64') !== server.privateKey) throw new TypeError('Invalid cell private key');
  const v4 = subnet(server.ipv4Subnet, server.address4, 4);
  if (Boolean(server.address6) !== Boolean(server.ipv6Subnet)) throw new TypeError('Incomplete IPv6 context');
  const v6 = server.address6 ? subnet(server.ipv6Subnet, server.address6, 6) : null;
  if (v6 && !['nat66', 'routed'].includes(server.ipv6Mode)) throw new TypeError('Explicit IPv6 mode required');
  for (const client of normalized.clients) {
    for (const [family, range] of [[4, v4], [6, v6]]) {
      const address = client[`address${family}`];
      if (address === undefined) continue;
      if (!range) throw new TypeError('Client address family unavailable on cell');
      const value = ipNumber(address);
      if (value < range.start || value > range.end || value === range.server
        || (family === 4 && range.prefix <= 30 && (value === range.start || value === range.end))) {
        throw new TypeError('Client address conflicts with cell network');
      }
    }
  }
  const active = normalized.clients.filter(client => client.ipv4Enabled || client.ipv6Enabled);
  const list = (group, family) => active.filter(client => client.networkGroup === group && client[`ipv${family}Enabled`])
    .map(client => client[`address${family}`]);
  const serverConfig = renderServerConfig({ privateKey: server.privateKey, listenPort: server.listenPort,
    addresses: [`${server.address4}/${v4.prefix}`, ...(v6 ? [`${server.address6}/${v6.prefix}`] : [])],
    profile: server.profile, peers: active.map(client => ({ name: client.id, publicKey: client.publicKey,
      presharedKey: client.presharedKey, allowedIps: [`${client.address4}/32`, ...(client.address6 ? [`${client.address6}/128`] : [])] })) });
  const nftables = renderNftablesPolicy({ interfaceName: server.interfaceName, wanInterface: server.wanInterface,
    ipv4Subnet: server.ipv4Subnet, ipv6Subnet: server.ipv6Subnet, nat66: v6 ? server.ipv6Mode === 'nat66' : false,
    headlessCell: true, home4: list('home', 4), guest4: list('guest', 4),
    home6: list('home', 6), guest6: list('guest', 6), geoDatabase,
    geoClients: active.map(client => ({ policy: client.geoPolicy,
      address4: client.ipv4Enabled ? client.address4 : undefined,
      address6: client.ipv6Enabled ? client.address6 : undefined })) });
  return { serverConfig, nftables, interfaceName: server.interfaceName };
}

module.exports = { buildCellArtifacts };
