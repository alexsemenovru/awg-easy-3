'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { parseDatabase } = require('./GeoIpSource');

if (!isMainThread) {
  try { parentPort.postMessage({ result: parseDatabase(workerData) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
}

const parseInWorker = (bytes, { signal, timeoutMs = 120000 } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('GeoIP parsing cancelled')); return; }
  const worker = new Worker(__filename, { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  let done = false;
  let timer;
  const finish = (error, result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    void worker.terminate();
    if (error) reject(error); else resolve(result);
  };
  const abort = () => finish(new Error('GeoIP parsing cancelled or timed out'));
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(abort, timeoutMs);
  worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.result));
  worker.once('error', error => finish(error));
  worker.once('exit', () => { if (!done) finish(new Error('GeoIP parser exited without a result')); });
});

module.exports = { parseInWorker };
