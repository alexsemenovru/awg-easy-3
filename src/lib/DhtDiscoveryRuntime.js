'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { DhtBudgetSocket } = require('./DhtBudgetSocket');
const { DhtContactCache } = require('./DhtContactCache');
const { CellDhtCursorStore } = require('./CellDhtCursorStore');
const { CellDhtContactExchange } = require('./CellDhtContactExchange');
const { targetFor, verifyCellLocator } = require('./CellDhtLocator');
const { retainOwnRecord } = require('./BittorrentDhtOwnRecord');

const BOOTSTRAP = Object.freeze(['router.bittorrent.com:6881',
  'router.utorrent.com:6881', 'dht.transmissionbt.com:6881']);
const RELAY_TOPIC = crypto.createHash('sha1').update('awg-easy-3/technical-relay/v1').digest();
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
    aliases = [],
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
    if (!Array.isArray(aliases) || aliases.length > 2 || kind !== 'main' && aliases.length) throw new Error('Invalid discovery aliases');
    for (const alias of aliases) {
      targetFor(alias.publicKey);
      if (crypto.createPublicKey(crypto.createPrivateKey(alias.privateKey)).export({ format: 'jwk' }).x !== alias.publicKey) throw new Error('Discovery alias identity mismatch');
    }
    this.publicationIdentities = [...new Map([identity, ...aliases].map(value => [value.publicKey, value])).values()];
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
    this.relayEnabled = false;
    this.relayPeers = new Map();
    this.lastRelayRefresh = 0;
  }

  setPeers(peers) {
    if (!Array.isArray(peers) || peers.length > 128) throw new Error('Invalid DHT peer inventory');
    const unique = new Map();
    for (const peer of peers) {
      if (!peer || !['main', 'cell'].includes(peer.kind)) throw new Error('Invalid DHT peer role');
      targetFor(peer.publicKey);
      const lookupKeys = peer.lookupKeys === undefined ? [peer.publicKey] : peer.lookupKeys;
      if (!Array.isArray(lookupKeys) || !lookupKeys.length || lookupKeys.length > 2 || new Set(lookupKeys).size !== lookupKeys.length) throw new Error('Invalid discovery lookup keys');
      lookupKeys.forEach(targetFor);
      if (peer.publicKey !== this.identity.publicKey) unique.set(peer.publicKey,
        { publicKey: peer.publicKey, kind: peer.kind, ...(peer.lookupKeys === undefined ? {} : { lookupKeys: [...lookupKeys] }) });
    }
    this.peers = [...unique.values()];
    for (const key of this.hints.keys()) if (!unique.has(key)) this.hints.delete(key);
  }

  exchange(publicKey, kind) {
    return new CellDhtContactExchange({ dht: this.dht, cellKey: publicKey, kind,
      retainOwn: this.publicationIdentities.some(value => value.publicKey === publicKey) ? options => retainOwnRecord(this.dht,
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
    this.dht.on('peer', (peer, infoHash) => {
      if (!this.relayEnabled || !Buffer.isBuffer(infoHash) || !infoHash.equals(RELAY_TOPIC)
        || net.isIP(peer.host) !== 4 || !Number.isInteger(peer.port) || peer.port < 1 || peer.port > 65535) return;
      const key = `${peer.host}:${peer.port}`;
      if (!this.relayPeers.has(key) && this.relayPeers.size >= 64) this.relayPeers.delete(this.relayPeers.keys().next().value);
      this.relayPeers.set(key, { host: peer.host, port: peer.port, expiresAt: this.now() + 600000 });
    });
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
        for (const signer of this.publicationIdentities) {
          try { await this.exchange(signer.publicKey, this.kind).publish({
            privateKey: signer.privateKey, host, port: this.dht.address().port, now }); }
          catch { this.failures++; } // Historical-key conflicts cannot suppress recovery aliases.
        }
        this.lastPublished = now;
      } catch { this.failures++; }
    }
    // Rotate a bounded slice of pinned identities; never enumerate arbitrary
    // public-DHT users or infer a total global participant count.
    const peers = [...this.peers];
    for (let index = 0; index < Math.min(8, peers.length) && !this.closing; index++) {
      const peer = peers[this.offset++ % peers.length];
      try {
        const hint = (await this.lookupRelayTargets(peer.publicKey, peer.kind))[0];
        if (hint && this.peers.some(current => current.publicKey === peer.publicKey)) {
          this.hints.set(peer.publicKey, hint);
          this.dht.addNode({ host: hint.host, port: hint.port });
        }
      } catch { this.failures++; }
    }
    if (!this.closing) await this.cache.write(this.contacts());
    if (this.relayEnabled && !this.closing && now - this.lastRelayRefresh >= 300000) {
      this.lastRelayRefresh = now;
      try {
        await this.relayOperation(done => this.dht.announce(RELAY_TOPIC, this.dht.address().port, done));
        await this.relayOperation(done => this.dht.lookup(RELAY_TOPIC, done));
      } catch { this.failures++; }
    }
  }

  enableRelayDiscovery() { this.relayEnabled = true; }
  relayCandidates() {
    for (const [key, value] of this.relayPeers) if (value.expiresAt <= this.now()) this.relayPeers.delete(key);
    return [...this.relayPeers.values()].map(({ host, port }) => ({ host, port }));
  }
  relayOperation(start) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let abort;
      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        if (typeof abort === 'function') abort();
        reject(new Error('DHT relay rendezvous timed out'));
      }, 10000);
      try {
        abort = start(error => {
          if (finished) return;
          finished = true; clearTimeout(timeout);
          if (error) reject(error); else resolve();
        });
      } catch (error) { finished = true; clearTimeout(timeout); reject(error); }
    });
  }

  contacts() {
    return [...this.hints.values()].filter(hint => hint.expiresAt > this.now())
      .map(hint => ({ host: hint.host, port: hint.port })).concat(this.dht.toJSON().nodes);
  }

  contact(publicKey) {
    const hint = this.hints.get(publicKey);
    return hint && hint.expiresAt > this.now() ? { ...hint } : null;
  }
  async lookupRelayTarget(publicKey, kind) {
    const known = this.contact(publicKey);
    if (known) return known;
    // Public-network forwarding must not create disk state for arbitrary keys.
    // Only the receiver decides whether this origin is its registered partner.
    const exchange = new CellDhtContactExchange({ dht: this.dht, cellKey: publicKey, kind,
      cursor: { reserve: () => { throw new Error('Relay cannot publish a foreign identity'); },
        accept: item => verifyCellLocator(item, { cellKey: publicKey, kind, now: this.now() }) },
      timeoutMs: 10000 });
    return exchange.lookup(this.now());
  }
  async lookupRelayTargets(publicKey, kind) {
    const peer = this.peers.find(value => value.publicKey === publicKey && value.kind === kind);
    const keys = peer?.lookupKeys ?? [publicKey];
    const hints = [];
    for (const key of keys) {
      try {
        const cached = this.contact(publicKey);
        const hint = cached?.cellKey === key ? cached : peer
          ? await this.exchange(key, kind).lookup(this.now()) : await this.lookupRelayTarget(key, kind);
        if (hint) hints.push({ ...hint, lookupKey: key });
      } catch { this.failures++; }
    }
    return hints;
  }
  status() {
    return Object.freeze({ state: this.closing ? 'stopped' : this.dht?.listening ? 'listening' : 'starting',
      routingContacts: this.dht?.nodes.count() || 0, knownPeers: this.peers.length,
      locatedPeers: [...this.hints.values()].filter(hint => hint.expiresAt > this.now()).length,
      relayCandidates: this.relayCandidates().length,
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

module.exports = { DhtDiscoveryRuntime, BOOTSTRAP, RELAY_TOPIC, verifyMutable };
