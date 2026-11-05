'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { DhtBudgetSocket } = require('./DhtBudgetSocket');
const { DhtContactCache } = require('./DhtContactCache');
const { CellDhtCursorStore } = require('./CellDhtCursorStore');
const { CellDhtContactExchange } = require('./CellDhtContactExchange');
const { targetFor } = require('./CellDhtLocator');
const { retainOwnRecord } = require('./BittorrentDhtOwnRecord');

const BOOTSTRAP = Object.freeze(['router.bittorrent.com:6881',
  'router.utorrent.com:6881', 'dht.transmissionbt.com:6881']);
const verifyMutable = (signature, bytes, rawKey) => {
  try {
    if (rawKey.length !== 32 || signature.length !== 64) return false;
    return crypto.verify(null, bytes, crypto.createPublicKey({ format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(rawKey).toString('base64url') } }), signature);
  } catch { return false; }
};

// Discovery only: DHT stores signed short-lived contact hints. It never carries
// settings, VPN profiles, commands, client statistics or backup archives.
class DhtDiscoveryRuntime {
  constructor({ directory, identity, kind, endpointHost, port,
    bootstrap = BOOTSTRAP, bindAddress = '0.0.0.0',
    newDht, socket, now = Date.now, resolve = host => dns.lookup(host, { family: 4 }) }) {
    if (!path.isAbsolute(directory) || !['main', 'cell'].includes(kind)
      || !Number.isInteger(port) || port < 0 || port > 65535
      || typeof newDht !== 'function' || typeof now !== 'function' || typeof resolve !== 'function') {
      throw new TypeError('Invalid DHT discovery configuration');
    }
    targetFor(identity.publicKey);
    const key = crypto.createPrivateKey(identity.privateKey);
    if (crypto.createPublicKey(key).export({ format: 'jwk' }).x !== identity.publicKey) {
      throw new Error('DHT identity mismatch');
    }
    Object.assign(this, { directory, identity, kind, endpointHost, port, bootstrap,
      bindAddress, newDht, now, resolve });
    this.socket = socket || new DhtBudgetSocket();
    this.cache = new DhtContactCache(directory);
    this.peers = [];
    this.hints = new Map();
    this.offset = 0;
    this.lastPublished = 0;
    this.running = null;
    this.closing = false;
    this.failures = 0;
  }

  setPeers(peers) {
    if (!Array.isArray(peers) || peers.length > 128) throw new Error('Invalid DHT peer inventory');
    const unique = new Map();
    for (const peer of peers) {
      if (!peer || !['main', 'cell'].includes(peer.kind)) throw new Error('Invalid DHT peer role');
      targetFor(peer.publicKey);
      if (peer.publicKey !== this.identity.publicKey) unique.set(peer.publicKey,
        { publicKey: peer.publicKey, kind: peer.kind });
    }
    this.peers = [...unique.values()];
    for (const key of this.hints.keys()) if (!unique.has(key)) this.hints.delete(key);
  }

  exchange(publicKey, kind) {
    return new CellDhtContactExchange({ dht: this.dht, cellKey: publicKey, kind,
      retainOwn: publicKey === this.identity.publicKey ? options => retainOwnRecord(this.dht,
        options, { publicKey, kind, now: this.now() }) : undefined,
      cursor: new CellDhtCursorStore(path.join(this.directory, `${publicKey}.json`), publicKey, { kind }),
      timeoutMs: 10000 });
  }

  async start() {
    const contacts = await this.cache.read();
    this.dht = this.newDht({ socket: this.socket, verify: verifyMutable,
      bootstrap: this.bootstrap === false ? false : [...contacts, ...this.bootstrap],
      concurrency: 2, backgroundConcurrency: 1, maxTables: 64, maxValues: 128,
      maxPeers: 64, maxAge: 15 * 60 * 1000 });
    this.dht.on('error', () => { this.failures++; });
    this.dht.on('warning', () => {}); // Never log third-party addresses or values.
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('DHT bind timed out')); }, 5000);
        const cleanup = () => { clearTimeout(timeout); this.dht.off('error', failed); };
        const failed = () => { cleanup(); reject(new Error('DHT socket unavailable')); };
        this.dht.once('error', failed);
        this.dht.listen(this.port, this.bindAddress, () => { cleanup(); resolve(); });
      });
      this.timer = setInterval(() => { this.tick().catch(() => { this.failures++; }); }, 30000);
      this.timer.unref();
      return this;
    } catch (error) { await this.close(); throw error; }
  }

  tick() {
    if (this.closing) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.refresh().finally(() => { this.running = null; });
    return this.running;
  }

  async refresh() {
    const now = this.now();
    for (const [key, hint] of this.hints) if (hint.expiresAt <= now) this.hints.delete(key);
    if (!this.lastPublished || now - this.lastPublished >= 5 * 60 * 1000) {
      try {
        const host = net.isIP(this.endpointHost) === 4 ? this.endpointHost
          : (await this.resolve(this.endpointHost)).address;
        if (net.isIP(host) !== 4) throw new Error('DHT requires IPv4 discovery address');
        await this.exchange(this.identity.publicKey, this.kind).publish({
          privateKey: this.identity.privateKey, host, port: this.dht.address().port, now });
        this.lastPublished = now;
      } catch { this.failures++; }
    }
    // Rotate a bounded slice of pinned identities; never enumerate arbitrary
    // public-DHT users or infer a total global participant count.
    const peers = [...this.peers];
    for (let index = 0; index < Math.min(8, peers.length) && !this.closing; index++) {
      const peer = peers[this.offset++ % peers.length];
      try {
        const hint = await this.exchange(peer.publicKey, peer.kind).lookup(this.now());
        if (hint && this.peers.some(current => current.publicKey === peer.publicKey)) {
          this.hints.set(peer.publicKey, hint);
          this.dht.addNode({ host: hint.host, port: hint.port });
        }
      } catch { this.failures++; }
    }
    if (!this.closing) await this.cache.write(this.contacts());
  }

  contacts() {
    return [...this.hints.values()].filter(hint => hint.expiresAt > this.now())
      .map(hint => ({ host: hint.host, port: hint.port })).concat(this.dht.toJSON().nodes);
  }

  contact(publicKey) {
    const hint = this.hints.get(publicKey);
    return hint && hint.expiresAt > this.now() ? { ...hint } : null;
  }
  status() {
    return Object.freeze({ state: this.closing ? 'stopped' : this.dht?.listening ? 'listening' : 'starting',
      routingContacts: this.dht?.nodes.count() || 0, knownPeers: this.peers.length,
      locatedPeers: [...this.hints.values()].filter(hint => hint.expiresAt > this.now()).length,
      failures: this.failures, ...this.socket.stats() });
  }
  async close() {
    if (this.closed) return this.closed;
    this.closing = true;
    clearInterval(this.timer);
    this.closed = (async () => {
      if (this.dht && !this.dht.destroyed) {
        try { await this.cache.write(this.contacts()); } catch { /* Preserve old cache. */ }
        await new Promise(resolve => this.dht.destroy(resolve));
      }
      await this.running?.catch(() => {});
      this.hints.clear();
    })();
    return this.closed;
  }
}

module.exports = { DhtDiscoveryRuntime, BOOTSTRAP, verifyMutable };
