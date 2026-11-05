'use strict';

const path = require('node:path');
const { startDhtDiscovery } = require('./DhtDiscoverySupervisor');
const { runProcess } = require('./ProcessRunner');

async function openNodeDiscovery({ role, config, host, start = startDhtDiscovery, runner = runProcess }) {
  try {
    const identity = await host.identityStore.load(role === 'main' ? 'controller' : 'cell');
    let controlPort = role === 'main' ? config.permanentEndpointPort : null;
    if (role === 'cell') {
      try {
        const name = config.resources.interfaceNames[1];
        if (!/^[A-Za-z0-9_.-]{1,15}$/.test(name)) throw new Error('Invalid owned control interface');
        const result = await runner('awg', ['show', name, 'listen-port'], { timeoutMs: 3000, maxOutputBytes: 128 });
        const detected = Number(result.stdout);
        if (Number.isInteger(detected) && detected > 0 && detected <= 65535) controlPort = detected;
      } catch { /* Discovery and relay forwarding still work without a local AWG socket. */ }
    }
    return start({ directory: path.join(config.stateDirectory, 'discovery'),
      identity, kind: role, endpointHost: config.endpointHost, port: config.dhtPort, controlPort,
      peers: async () => {
        if (role === 'cell') {
          const connection = await host.connectionStore.read();
          return connection?.status === 'registered'
            ? [{ publicKey: connection.controllerKey, kind: 'main' }] : [];
        }
        const state = await host.bootstrapStore.read();
        return state.invitations.filter(record => record.status === 'consumed'
          && record.phase === 'closed').map(record => ({ publicKey: record.cellKey, kind: 'cell' }));
      } });
  } catch {
    return Object.freeze({ status: () => ({ state: 'unavailable' }), close: async () => {} });
  }
}

module.exports = { openNodeDiscovery };
