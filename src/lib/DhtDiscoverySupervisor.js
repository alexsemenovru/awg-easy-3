'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

// No addresses or private keys in argv, status messages or logs. DHT failure
// cannot reject the VPN poller/reconciler or alter its routes and access rules.
function startDhtDiscovery({ directory, identity, kind, endpointHost, port, bootstrap,
  bindAddress, peers = async () => [],
  newWorker = (file, options) => new Worker(file, options) }) {
  let worker;
  let timer;
  let retry;
  let stopped = false;
  let attempts = 0;
  let status = Object.freeze({ state: 'starting' });
  const start = () => {
    if (stopped) return;
    try {
      worker = newWorker(path.join(__dirname, '../dht-worker.js'), {
        workerData: { directory, identity, kind, endpointHost, port, bootstrap, bindAddress },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
        name: 'network-discovery',
      });
      worker.on('error', () => { status = Object.freeze({ state: 'unavailable' }); });
      worker.on('message', message => {
        if (message?.type === 'status') status = Object.freeze({ ...message.status });
        else if (message?.type === 'unavailable') status = Object.freeze({ state: 'unavailable' });
      });
      worker.once('exit', () => {
        worker = null;
        status = Object.freeze({ state: stopped ? 'stopped' : 'unavailable' });
        if (!stopped) {
          retry = setTimeout(start, Math.min(300000, 10000 * 2 ** Math.min(attempts++, 5)));
          retry.unref();
        }
      });
      refresh();
    } catch {
      status = Object.freeze({ state: 'unavailable' });
      retry = setTimeout(start, 60000);
      retry.unref();
    }
  };
  let refreshing = false;
  const refresh = async () => {
    if (stopped || !worker || refreshing) return;
    refreshing = true;
    try {
      const inventory = await peers();
      if (worker && !stopped) worker.postMessage({ type: 'peers', peers: inventory });
    } catch { /* An unavailable inventory never authorizes unknown identities. */ }
    finally { refreshing = false; }
  };
  start();
  timer = setInterval(refresh, 30000);
  timer.unref();
  return Object.freeze({ status: () => status, close: async () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(retry);
    const closing = worker;
    if (!closing) return;
    await new Promise(resolve => {
      const deadline = setTimeout(() => { closing.terminate().then(resolve, resolve); }, 5000);
      closing.once('exit', () => { clearTimeout(deadline); resolve(); });
      try { closing.postMessage({ type: 'stop' }); }
      catch { clearTimeout(deadline); resolve(); }
    });
  } });
}

module.exports = { startDhtDiscovery };
