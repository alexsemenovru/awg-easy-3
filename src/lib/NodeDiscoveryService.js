'use strict';

const path = require('node:path');
const { startDhtDiscovery } = require('./DhtDiscoverySupervisor');

async function openNodeDiscovery({ role, config, host, start = startDhtDiscovery }) {
  try {
    const identity = await host.identityStore.load(role === 'main' ? 'controller' : 'cell');
    return start({ directory: path.join(config.stateDirectory, 'discovery'),
      identity, kind: role, endpointHost: config.endpointHost, port: config.dhtPort,
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
