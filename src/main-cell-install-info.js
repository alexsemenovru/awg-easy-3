'use strict';

const { StateStore } = require('./lib/StateStore');
const { validEndpointHost } = require('./lib/CellAwgEndpointHost');

function installationInfo(state) {
  const server = state?.server;
  if (!server || !/^[a-zA-Z0-9_.-]{1,15}$/.test(server.interfaceName)
    || !Number.isSafeInteger(server.listenPort) || server.listenPort < 1
    || server.listenPort > 65535 || !Number.isSafeInteger(server.panelPort)
    || server.panelPort < 1 || server.panelPort > 65535
    || !validEndpointHost(server.endpointHost)) {
    throw new Error('Invalid persisted Main endpoint');
  }
  return `${server.interfaceName} ${server.listenPort} ${server.panelPort} ${server.endpointHost}\n`;
}

async function main() {
  const state = await new StateStore('/data/state.json').load();
  if (process.argv.includes('--verify') && !await require('./lib/MainUserTunnelVerifier').verifyMainUserTunnel(state)) throw new Error('Unverified panel interface');
  process.stdout.write(installationInfo(state));
}

if (require.main === module) main().catch(() => {
  console.error('Cannot read validated Main installation metadata');
  process.exitCode = 1;
});

module.exports = { installationInfo, main };
