'use strict';
process.title = 'network-maintenance';
const path = require('node:path');
const { CellMaintenanceHost } = require('./lib/CellMaintenanceHost');
const { ControlIdentityStore } = require('./lib/ControlIdentityStore');
const { CellAwgConnectionStore } = require('./lib/CellAwgConnectionStore');
const { BackupJournal } = require('./lib/BackupJournal');
const { verifyHostRequest, receiptFor, verifyReceiptAck } = require('./lib/CellMaintenance');
const { cleanupCellOwnedResources } = require('./lib/CellOwnedCleanup');
const { configFromEnvironment } = require('./lib/CellBootstrapCli');
const { connectTechnicalRelay, discoverRelayIdentity } = require('./lib/AwgTechnicalRelay');
const { DhtDiscoveryRuntime } = require('./lib/DhtDiscoveryRuntime');
const { recoveryStoreFor } = require('./lib/CellControlAuthority');

async function main(action) {
  const root = '/cell-data', host = new CellMaintenanceHost('/maintenance-host');
  const identityStore = new ControlIdentityStore(path.join(root, 'identity.json'));
  const identity = await identityStore.load('cell');
  const connectionStore = new CellAwgConnectionStore(path.join(root, 'connection.json'), identityStore);
  const connection = await connectionStore.read();
  if (connection?.status !== 'registered' || connection.cellKey !== identity.publicKey) throw new Error('Cell is not registered');
  if (action === 'init') {
    await host.initialize({ identity, connection, containerId: process.env.MAINTENANCE_CONTAINER_ID,
      imageId: process.env.MAINTENANCE_IMAGE_ID }); return;
  }
  if (action === 'check') {
    const anchor = await host.anchor.read();
    const request = await new BackupJournal(path.join(root, 'maintenance/request.json'),
      value => verifyHostRequest(value, anchor), 8192).read();
    if (!request) return;
    await host.prepare(request);
  }
  const state = await host.read();
  if (action === 'check' || action === 'status') {
    process.stdout.write([state.phase, state.command.id, state.command.action,
      state.command.targetVersion ?? '-', state.containerId, state.imageId].join('\n') + '\n'); return;
  }
  if (action === 'stopped') { await host.advance('stopped'); return; }
  if (action === 'removed') { await host.advance('container-removed'); return; }
  if (action === 'replace') {
    if (require('./package.json').version !== state.command.targetVersion) throw new Error('Replacement version differs');
    await host.replace({ containerId: process.env.MAINTENANCE_CONTAINER_ID, imageId: process.env.MAINTENANCE_IMAGE_ID }); return;
  }
  if (action === 'cleanup') {
    const config = configFromEnvironment(process.env);
    await cleanupCellOwnedResources({ config, authorizeStopped: async () => {
      const saved = await host.read();
      if (saved.command.action !== 'remove' || saved.phase !== 'stopped') throw new Error('Container is not stopped');
    } });
    await host.advance('resources-removed'); return;
  }
  if (action !== 'receipt' || state.command.action !== 'remove' || state.phase !== 'container-removed') throw new Error('Invalid maintenance operation');
  const command = state.command, receipt = receiptFor(command, identity);
  const deliver = async (address, serverKey, locatorKey) => {
    const net = require('node:net');
    const hosts = net.isIP(address.host) ? [{ address: address.host }]
      : (await require('node:dns/promises').lookup(address.host, { all: true })).slice(0, 4);
    for (const host of hosts) {
      let frames;
      try {
        frames = await connectTechnicalRelay({ host: host.address, port: address.port, serverKey, locatorKey, identity,
          target: command.controllerKey, kind: 'main', purpose: 'receipt' });
        await frames.json(receipt); verifyReceiptAck(await frames.readJson(), command); return;
      } catch { /* Try another address of this same pinned Main identity. */ }
      finally { frames?.close(); }
    }
    throw new Error('Main receipt endpoint unavailable');
  };
  try { await deliver({ host: command.receiptHost, port: command.receiptPort }, command.controllerKey); }
  catch {
    const { default: DHT } = await import('bittorrent-dht');
    const recovery = await recoveryStoreFor(connectionStore, connection)?.read();
    const lookupKeys = [...new Set([recovery?.grant?.recoveryKey, command.authorityKey ?? command.controllerKey].filter(Boolean))];
    const discovery = new DhtDiscoveryRuntime({ directory: '/maintenance-host/discovery', identity,
      kind: 'cell', endpointHost: '127.0.0.1', port: 0, newDht: options => new DHT(options) });
    try {
      discovery.setPeers([{ publicKey: command.controllerKey, kind: 'main', lookupKeys }]);
      await discovery.start();
      const contacts = await discovery.lookupRelayTargets(command.controllerKey, 'main');
      let delivered = false;
      for (const contact of contacts) {
        try { await deliver(contact, command.controllerKey); delivered = true; break; } catch { /* bounded candidates */ }
      }
      if (!delivered) for (const candidate of discovery.relayCandidates().slice(0, 3)) {
        const key = await discoverRelayIdentity(candidate).catch(() => null);
        if (!key || key === identity.publicKey) continue;
        for (const locator of lookupKeys) {
          try { await deliver(candidate, key, locator); delivered = true; break; } catch { /* one-hop only */ }
        }
        if (delivered) break;
      }
      if (!delivered) throw new Error('Main receipt path unavailable');
    } finally { await discovery.close(); }
  }
  await host.advance('complete');
}
main(process.argv[2]).catch(() => {
  console.error('Network maintenance pending; private state retained'); process.exitCode = 1;
});
