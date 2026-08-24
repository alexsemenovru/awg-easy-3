'use strict';

const { runProcess } = require('./ProcessRunner');

const ONLINE_AFTER_SECONDS = 150;

const parseAwgDump = (output) => {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  return new Map(lines.slice(1).map((line) => {
    const fields = line.split('\t');
    if (fields.length < 8) throw new Error('Unexpected AWG dump format');
    return [fields[0], {
      endpoint: fields[2] === '(none)' ? null : fields[2],
      lastHandshake: Number(fields[4]),
      receivedBytes: Number(fields[5]),
      sentBytes: Number(fields[6]),
    }];
  }));
};

class ClientDiagnostics {
  constructor({ store, runner = runProcess, now = () => Date.now() } = {}) {
    if (!store || typeof store.load !== 'function') throw new TypeError('store must provide load');
    if (typeof runner !== 'function' || typeof now !== 'function') throw new TypeError('runner and now must be functions');
    this.store = store;
    this.runner = runner;
    this.now = now;
    this.previous = new Map();
  }

  async snapshot() {
    const state = await this.store.load();
    const measuredAt = this.now();
    const dump = parseAwgDump((await this.runner('awg', ['show', state.server.interfaceName, 'dump'])).stdout);
    const result = state.clients.map((client) => {
      const peer = dump.get(client.publicKey);
      const previous = this.previous.get(client.publicKey);
      const elapsed = previous ? Math.max((measuredAt - previous.measuredAt) / 1000, 0.001) : 0;
      const handshakeAgeSeconds = peer?.lastHandshake
        ? Math.max(0, Math.floor(measuredAt / 1000) - peer.lastHandshake) : null;
      const rates = peer && previous ? {
        downloadBps: Math.max(0, Math.round((peer.sentBytes - previous.sentBytes) / elapsed)),
        uploadBps: Math.max(0, Math.round((peer.receivedBytes - previous.receivedBytes) / elapsed)),
      } : { downloadBps: 0, uploadBps: 0 };
      if (peer) this.previous.set(client.publicKey, { ...peer, measuredAt });
      return Object.freeze({
        id: client.id,
        state: client.enabled === false ? 'disabled'
          : (handshakeAgeSeconds !== null && handshakeAgeSeconds <= ONLINE_AFTER_SECONDS ? 'online' : 'offline'),
        ...rates,
        handshakeAgeSeconds,
        lastHandshakeAt: peer?.lastHandshake ? new Date(peer.lastHandshake * 1000).toISOString() : null,
        endpoint: peer?.endpoint ?? null,
        mtu: client.mtu ?? 1280,
        persistentKeepalive: client.persistentKeepalive ?? '25-35',
      });
    });
    return Object.freeze(result);
  }
}

module.exports = { ClientDiagnostics, ONLINE_AFTER_SECONDS, parseAwgDump };
