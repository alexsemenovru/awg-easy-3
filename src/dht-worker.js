'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DhtDiscoveryRuntime } = require('./lib/DhtDiscoveryRuntime');
const { AwgTechnicalRelay, openTechnicalBridge, discoverRelayIdentity } = require('./lib/AwgTechnicalRelay');
const { relayLocatorOrder } = require('./lib/RelayLocatorOrder');

async function main() {
  const { default: DHT } = await import('bittorrent-dht');
  const service = new DhtDiscoveryRuntime({ ...workerData, newDht: options => new DHT(options) });
  let timer;
  let closing = false;
  let starting;
  let relay;
  let bridge;
  let openingBridge = false;
  let bridgeTarget;
    const relayAttempts = new Map();
  parentPort.on('message', async message => {
    if (message?.type === 'stop' && !closing) {
      closing = true;
      clearInterval(timer);
      await starting.catch(() => {});
      if (bridge) await bridge.close();
      if (relay) await relay.close();
      await service.close();
      parentPort.close();
    } else if (message?.type === 'peers' && !closing) {
      try {
        service.setPeers(message.peers);
          for (const key of relayAttempts.keys()) if (!service.peers.some(peer => peer.publicKey === key)) relayAttempts.delete(key);
        if (relay) await relay.refreshPeers();
        if (bridge && !service.peers.some(peer => peer.publicKey === bridgeTarget)) {
          await bridge.close(); bridge = null;
        }
      } catch { /* Reject whole invalid inventory. */ }
    } else if (message?.type === 'open-bridge' && !closing) {
      const id = message.id;
      if (openingBridge || !/^[a-f0-9]{32}$/.test(id || '')) return;
      openingBridge = true;
      try {
        const peer = service.peers.find(item => item.publicKey === message.target);
        if (!peer || !workerData.controlPort || require('node:net').isIP(message.source4) !== 4) throw new Error('No registered technical target');
        if (bridge) { await bridge.close(); bridge = null; }
        const contacts = await service.lookupRelayTargets(peer.publicKey, peer.kind);
          const attempt = relayAttempts.get(peer.publicKey) ?? 0;
          relayAttempts.set(peer.publicKey, (attempt + 1) % 3);
        const open = (host, port, serverKey, locatorKey) => openTechnicalBridge({ host, port, serverKey, locatorKey,
          localAwgPort: workerData.controlPort, localAwgAddress: message.source4, identity: workerData.identity,
          target: peer.publicKey, kind: peer.kind });
        for (const contact of contacts) {
          try { bridge = await open(contact.host, contact.port, peer.publicKey); break; } catch { /* Try another pinned locator. */ }
        }
        if (!bridge) {
          for (const candidate of service.relayCandidates().slice(0, 3)) {
            try {
              const key = await discoverRelayIdentity(candidate);
              if (key === workerData.identity.publicKey || key === peer.publicKey) continue;
              const locatorKeys = relayLocatorOrder(peer, contacts, attempt);
              for (const locatorKey of locatorKeys) {
                try { bridge = await open(candidate.host, candidate.port, key,
                  locatorKey === peer.publicKey ? undefined : locatorKey); break; } catch { /* Try the next pinned alias. */ }
              }
              if (bridge) break;
            } catch { /* A public candidate has no authority; try the next bounded candidate. */ }
          }
        }
        if (!bridge) throw new Error('Technical route unavailable');
        if (closing || !service.peers.some(current => current.publicKey === peer.publicKey)) {
          await bridge.close(); bridge = null; throw new Error('Technical peer was revoked');
        }
        bridgeTarget = peer.publicKey;
        const opened = bridge;
        opened.running.finally(() => {
          if (bridge === opened) {
            bridge = null;
            parentPort.postMessage({ type: 'bridge-closed' });
          }
        }).catch(() => {});
        parentPort.postMessage({ type: 'bridge-result', id, address: bridge.address });
      } catch { parentPort.postMessage({ type: 'bridge-result', id, error: 'technical_unavailable' }); }
      finally { openingBridge = false; }
    } else if (message?.type === 'close-bridge' && bridge) {
      await bridge.close(); bridge = null;
    }
  });
  starting = (async () => {
    await service.start();
    if (closing || workerData.port === 0) return;
    try {
      relay = new AwgTechnicalRelay({ identity: workerData.identity, kind: workerData.kind,
        controlPort: workerData.controlPort ?? null,
        allowedPeer: key => service.peers.some(peer => peer.publicKey === key),
        lookup: (key, kind) => service.lookupRelayTarget(key, kind) });
      await relay.start(workerData.port, workerData.bindAddress || '0.0.0.0');
      service.enableRelayDiscovery();
    } catch { if (relay) await relay.close(); relay = null; }
  })();
  await starting;
  if (closing) return;
  const status = () => ({ ...service.status(), technical: relay
    ? { state: 'listening', bridgeActive: !!bridge, connections: relay.connections.size, ...relay.stats }
    : { state: 'unavailable' } });
  parentPort.postMessage({ type: 'status', status: status() });
  timer = setInterval(() => parentPort.postMessage({ type: 'status', status: status() }), 30000);
  timer.unref();
}

main().catch(() => { parentPort.postMessage({ type: 'unavailable' }); process.exitCode = 1; parentPort.close(); });
