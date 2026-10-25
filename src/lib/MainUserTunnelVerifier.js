'use strict';

const { renderServerConfig } = require('./AwgConfigRenderer');
const { matchesAwgConfig } = require('./CellAwgSnapshot');
const { clientTraffic } = require('./ClientTraffic');
const { runProcess } = require('./ProcessRunner');
const { ipNumber } = require('./GeoIpAddress');

// The panel and Main Cell sidecar share a network namespace, but not a runtime
// directory. Compare the live AWG configuration against persisted panel state
// without copying its private key into the Cell state or diagnostics.
async function verifyMainUserTunnel(state, { runner = runProcess } = {}) {
  if (!state || !state.server || !Array.isArray(state.clients)
    || typeof runner !== 'function') throw new TypeError('Panel state and runner required');
  const server = state.server;
  const ipv6 = Boolean(server.address6 && server.ipv6Subnet);
  const peers = state.clients.filter(client => !client.entryCellId && clientTraffic(client).enabled)
    .map(client => ({ name: client.name, publicKey: client.publicKey,
      presharedKey: client.presharedKey,
      allowedIps: [`${client.address4}/32`, ...(ipv6 && client.address6
        ? [`${client.address6}/128`] : [])] }));
  const rendered = renderServerConfig({ privateKey: server.privateKey,
    addresses: [`${server.address4}/${server.ipv4Prefix ?? 24}`,
      ...(ipv6 ? [`${server.address6}/${server.ipv6Prefix ?? 64}`] : [])],
    listenPort: server.listenPort, profile: server.profile, peers });
  const expected = rendered.split('\n').filter(line => !line.startsWith('Address = ')).join('\n');
  try {
    const [{ stdout: actual }, { stdout: addresses }] = await Promise.all([
      runner('awg', ['showconf', server.interfaceName], { maxOutputBytes: 4 * 1024 * 1024 }),
      runner('ip', ['-j', 'addr', 'show', 'dev', server.interfaceName],
        { maxOutputBytes: 65536 }),
    ]);
    if (!matchesAwgConfig(expected, actual)) return false;
    const rows = JSON.parse(addresses);
    if (!Array.isArray(rows) || rows.length !== 1
      || rows[0].ifname !== server.interfaceName
      || !Array.isArray(rows[0].addr_info)) return false;
    const has = (family, address) => rows[0].addr_info.some(row =>
      row.family === family && typeof row.local === 'string'
      && ipNumber(row.local) === ipNumber(address));
    return has('inet', server.address4) && (!ipv6 || has('inet6', server.address6));
  } catch { return false; }
}

module.exports = { verifyMainUserTunnel };
