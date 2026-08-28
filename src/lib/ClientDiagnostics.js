'use strict';

const { runProcess } = require('./ProcessRunner');
const { performance } = require('node:perf_hooks');

// AWG has no disconnect event. This is a recent-handshake estimate, not proof
// that the device is still reachable or has received the server's packets.
const ONLINE_AFTER_SECONDS = 150;
const MIN_SAMPLE_INTERVAL_MS = 1000;
const MAX_SAMPLE_GAP_MS = 15_000;

const parseCounter = (value) => {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0) {
    throw new Error('Unexpected AWG dump counter');
  }
  return number;
};

const parseAwgDump = (output) => {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines[0].split('\t').length < 4) throw new Error('Unexpected AWG dump format');
  return new Map(lines.slice(1).map((line) => {
    const fields = line.split('\t');
    if (fields.length < 8) throw new Error('Unexpected AWG dump format');
    const lastHandshake = parseCounter(fields[4]);
    if (lastHandshake > 8_640_000_000_000) throw new Error('Unexpected AWG dump timestamp');
    return [fields[0], {
      endpoint: fields[2] === '(none)' ? null : fields[2],
      lastHandshake,
      receivedBytes: parseCounter(fields[5]),
      sentBytes: parseCounter(fields[6]),
    }];
  }));
};

class ClientDiagnostics {
  constructor({ store, runner = runProcess, now = () => Date.now(), monotonicNow = () => performance.now() } = {}) {
    if (!store || typeof store.load !== 'function') throw new TypeError('store must provide load');
    if ([runner, now, monotonicNow].some((value) => typeof value !== 'function')) {
      throw new TypeError('runner and clocks must be functions');
    }
    this.store = store;
    this.runner = runner;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.previous = new Map();
    this.inFlight = null;
    this.cached = null;
    this.interfaceName = null;
  }

  snapshot() {
    // Multiple browsers must not race or replace each other's baselines.
    if (!this.inFlight) {
      this.inFlight = this.sample().catch((error) => {
        this.previous.clear();
        this.cached = null;
        throw error;
      }).finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async sample() {
    const state = await this.store.load();
    const stateKey = JSON.stringify([state.server.interfaceName, state.clients.map((client) =>
      [client.id, client.publicKey, client.enabled, client.mtu, client.persistentKeepalive])]);
    const cacheAge = this.cached ? this.monotonicNow() - this.cached.measuredAt : Infinity;
    if (this.cached?.stateKey === stateKey && cacheAge >= 0 && cacheAge < MIN_SAMPLE_INTERVAL_MS) {
      return this.cached.result;
    }
    const dump = parseAwgDump((await this.runner('awg', ['show', state.server.interfaceName, 'dump'], { timeoutMs: 5000 })).stdout);
    // Stamp the completed read; time spent waiting for AWG is part of the interval.
    const measuredAt = this.now();
    const sampleTime = this.monotonicNow();
    if (this.interfaceName !== state.server.interfaceName) this.previous.clear();
    const nextPrevious = new Map();
    const result = state.clients.map((client) => {
      const peer = client.enabled === false ? undefined : dump.get(client.publicKey);
      const previous = this.previous.get(client.publicKey);
      const elapsedMs = previous ? sampleTime - previous.measuredAt : 0;
      const usable = peer && previous && elapsedMs > 0 && elapsedMs <= MAX_SAMPLE_GAP_MS
        && peer.sentBytes >= previous.sentBytes && peer.receivedBytes >= previous.receivedBytes;
      const handshakeAgeSeconds = peer?.lastHandshake
        ? Math.max(0, Math.floor(measuredAt / 1000) - peer.lastHandshake) : null;
      const rates = usable ? {
        downloadBps: Math.round((peer.sentBytes - previous.sentBytes) * 1000 / elapsedMs),
        uploadBps: Math.round((peer.receivedBytes - previous.receivedBytes) * 1000 / elapsedMs),
      } : { downloadBps: peer ? null : 0, uploadBps: peer ? null : 0 };
      if (peer) nextPrevious.set(client.publicKey, { ...peer, measuredAt: sampleTime });
      return Object.freeze({
        id: client.id,
        state: client.enabled === false ? 'disabled'
          : (handshakeAgeSeconds !== null && handshakeAgeSeconds <= ONLINE_AFTER_SECONDS ? 'online' : 'offline'),
        ...rates,
        sampleIntervalSeconds: usable ? elapsedMs / 1000 : null,
        handshakeAgeSeconds,
        lastHandshakeAt: peer?.lastHandshake ? new Date(peer.lastHandshake * 1000).toISOString() : null,
        endpoint: peer?.endpoint ?? null,
        mtu: client.mtu ?? 1280,
        persistentKeepalive: client.persistentKeepalive ?? '25-35',
      });
    });
    this.previous = nextPrevious;
    this.interfaceName = state.server.interfaceName;
    this.cached = { stateKey, measuredAt: sampleTime, result: Object.freeze(result) };
    return this.cached.result;
  }
}

module.exports = { ClientDiagnostics, ONLINE_AFTER_SECONDS, MIN_SAMPLE_INTERVAL_MS, MAX_SAMPLE_GAP_MS, parseAwgDump };
