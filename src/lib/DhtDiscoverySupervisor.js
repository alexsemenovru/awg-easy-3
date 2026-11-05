'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const crypto = require('node:crypto');

// No addresses or private keys in argv, status messages or logs. DHT failure
// cannot reject the VPN poller/reconciler or alter its routes and access rules.
function startDhtDiscovery({ directory, identity, kind, endpointHost, port, controlPort, bootstrap,
  bindAddress, peers = async () => [],
  newWorker = (file, options) => new Worker(file, options) }) {
  let worker;
  let timer;
  let retry;
  let stopped = false;
  let attempts = 0;
  let status = Object.freeze({ state: 'starting' });
  const requests = new Map();
  const start = () => {
    if (stopped) return;
    try {
      worker = newWorker(path.join(__dirname, '../dht-worker.js'), {
        workerData: { directory, identity, kind, endpointHost, port, controlPort, bootstrap, bindAddress },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
        name: 'network-discovery',
      });
      worker.on('error', () => { status = Object.freeze({ state: 'unavailable' }); });
      worker.on('message', message => {
        if (message?.type === 'status') status = Object.freeze({ ...message.status });
        else if (message?.type === 'unavailable') status = Object.freeze({ state: 'unavailable' });
        else if (message?.type === 'bridge-closed') status = Object.freeze({ ...status,
          technical: { ...status.technical, bridgeActive: false } });
        else if (message?.type === 'bridge-result') {
          const pending = requests.get(message.id);
          if (pending) {
            requests.delete(message.id); clearTimeout(pending.timer);
            if (message.error || message.address?.address !== '127.0.0.1'
              || !Number.isInteger(message.address.port) || message.address.port < 1 || message.address.port > 65535) {
              pending.reject(new Error('Technical route unavailable'));
            } else {
              status = Object.freeze({ ...status, technical: { ...status.technical, bridgeActive: true } });
              pending.resolve(Object.freeze({ ...message.address }));
            }
          } else if (worker && message.address) worker.postMessage({ type: 'close-bridge' });
        }
      });
      worker.once('exit', () => {
        worker = null;
        for (const [id, pending] of requests) { clearTimeout(pending.timer); pending.reject(new Error('Technical worker unavailable')); requests.delete(id); }
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
  return Object.freeze({ status: () => status,
    openBridge: (target, source4 = '127.0.0.1') => new Promise((resolve, reject) => {
      if (!worker || stopped || requests.size || require('node:net').isIP(source4) !== 4 || !/^[A-Za-z0-9_-]{43}$/.test(target)) return reject(new Error('Technical worker unavailable'));
      const id = crypto.randomBytes(16).toString('hex');
      const timer = setTimeout(() => {
        requests.delete(id);
        if (worker) worker.postMessage({ type: 'close-bridge' });
        reject(new Error('Technical route timed out'));
      }, 45000);
      requests.set(id, { resolve, reject, timer });
      try { worker.postMessage({ type: 'open-bridge', id, target, source4 }); }
      catch (error) { clearTimeout(timer); requests.delete(id); reject(error); }
    }),
    closeBridge: () => {
      status = Object.freeze({ ...status, technical: { ...status.technical, bridgeActive: false } });
      if (worker) worker.postMessage({ type: 'close-bridge' });
    },
    close: async () => {
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
