'use strict';

// Explicit disposable field probe. Config contains a newly generated TEST
// identity, not a panel profile. Only aggregate results are written to stdout.
const fs = require('node:fs/promises');
const path = require('node:path');
const { DhtDiscoveryRuntime, verifyMutable } = require('../src/lib/DhtDiscoveryRuntime');
const { DhtBudgetSocket } = require('../src/lib/DhtBudgetSocket');

async function main() {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) {
    throw new Error('Absolute private field configuration path required');
  }
  const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  if (!['seed', 'main', 'cell'].includes(config.role)
    || !Number.isInteger(config.durationMs) || config.durationMs < 5000 || config.durationMs > 300000) {
    throw new Error('Invalid disposable DHT probe configuration');
  }
  const { default: DHT } = await import('../src/node_modules/bittorrent-dht/index.js');
  const started = process.cpuUsage();
  const began = Date.now();
  let service;
  let finishing;
  let located = false;
  let passes = 0;
  const finish = () => finishing ||= (async () => {
    clearInterval(timer);
    clearTimeout(deadline);
    const stats = service.status ? service.status() : { routingContacts: service.nodes.count() };
    if (service.close) await service.close();
    else await new Promise(resolve => service.destroy(resolve));
    console.log(JSON.stringify({ role: config.role, located, passes,
      elapsedMs: Date.now() - began, cpu: process.cpuUsage(started),
      rssKiB: Math.round(process.memoryUsage().rss / 1024), ...stats }));
  })();
  let timer;
  const deadline = setTimeout(() => finish().catch(() => { process.exitCode = 1; }), config.durationMs);
  process.on('SIGTERM', () => finish().catch(() => { process.exitCode = 1; }));
  process.on('SIGINT', () => finish().catch(() => { process.exitCode = 1; }));
  if (config.role === 'seed') {
    service = new DHT({ bootstrap: false, verify: verifyMutable, socket: new DhtBudgetSocket(),
      maxValues: 128, maxPeers: 64, maxTables: 64, concurrency: 2 });
    service.on('error', () => {});
    await new Promise(resolve => service.listen(config.port, '0.0.0.0', resolve));
  } else {
    service = new DhtDiscoveryRuntime({ directory: config.directory, identity: config.identity,
      kind: config.role, endpointHost: config.host, port: config.port,
      bootstrap: config.bootstrap, newDht: options => new DHT(options) });
    service.setPeers([{ publicKey: config.peerKey, kind: config.role === 'main' ? 'cell' : 'main' }]);
    await service.start();
    timer = setInterval(() => {
      if (finishing) return;
      service.tick().then(() => {
        if (service.contact(config.peerKey)) { located = true; passes++; }
      }).catch(() => {});
    }, 5000);
  }
}

main().catch(() => { console.error('DHT field probe failed'); process.exitCode = 1; });
