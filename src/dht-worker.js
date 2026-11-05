'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DhtDiscoveryRuntime } = require('./lib/DhtDiscoveryRuntime');

async function main() {
  const { default: DHT } = await import('bittorrent-dht');
  const service = new DhtDiscoveryRuntime({ ...workerData, newDht: options => new DHT(options) });
  let timer;
  let closing = false;
  let starting;
  parentPort.on('message', async message => {
    if (message?.type === 'stop' && !closing) {
      closing = true;
      clearInterval(timer);
      await starting.catch(() => {});
      await service.close();
      parentPort.close();
    } else if (message?.type === 'peers' && !closing) {
      try { service.setPeers(message.peers); } catch { /* Reject whole invalid inventory. */ }
    }
  });
  starting = service.start();
  await starting;
  if (closing) return;
  parentPort.postMessage({ type: 'status', status: service.status() });
  timer = setInterval(() => parentPort.postMessage({ type: 'status', status: service.status() }), 30000);
  timer.unref();
}

main().catch(() => { parentPort.postMessage({ type: 'unavailable' }); process.exitCode = 1; parentPort.close(); });
