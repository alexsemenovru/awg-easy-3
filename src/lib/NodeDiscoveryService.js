'use strict';

const path = require('node:path');
const { startDhtDiscovery } = require('./DhtDiscoverySupervisor');
const { runProcess } = require('./ProcessRunner');
const { ControlIdentityStore } = require('./ControlIdentityStore');
const { MainBackupRecovery } = require('./MainBackupRecovery');
const { recoveryStoreFor } = require('./CellControlAuthority');

async function openNodeDiscovery({ role, config, host, start = startDhtDiscovery, runner = runProcess }) {
  try {
    const identity = await host.identityStore.load(role === 'main' ? 'controller' : 'cell');
    const aliases = [];
    if (role === 'main') {
      try { aliases.push(await new ControlIdentityStore(path.join(config.stateDirectory, 'authority.json')).load('controller')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const recovery = await new MainBackupRecovery(path.join(config.stateDirectory, 'restore-recovery.json'), identity.publicKey).journal.read();
      if (recovery) aliases.push({ publicKey: recovery.material.publicKey, privateKey: recovery.material.privateKey });
    }
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
      identity, aliases, kind: role, endpointHost: config.endpointHost, port: config.dhtPort, controlPort,
      ...(role === 'main' && typeof host.acceptMaintenanceReceipt === 'function'
        ? { onReceipt: receipt => host.acceptMaintenanceReceipt(receipt),
          receiptPeers: async () => (await host.bootstrapStore.read()).invitations
            .filter(record => record.retiredCellKey).map(record => record.retiredCellKey) } : {}),
      peers: async () => {
        if (role === 'cell') {
          const connection = await host.connectionStore.read();
          if (connection?.status !== 'registered') return [];
          const recovery = typeof host.connectionStore.filePath === 'string'
            ? await recoveryStoreFor(host.connectionStore, connection)?.read() : null;
          const lookupKeys = [...new Set([recovery?.grant?.recoveryKey,
            connection.authorityKey ?? connection.controllerKey].filter(Boolean))];
          return [{ publicKey: connection.controllerKey, kind: 'main',
            ...(lookupKeys.length === 1 && lookupKeys[0] === connection.controllerKey ? {} : { lookupKeys }) }];
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
