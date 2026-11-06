'use strict';

// A reserved technical path for ALREADY ENCRYPTED control-AWG datagrams.
// No TLS, VPN profiles, private AWG keys or arbitrary TCP/UDP destinations.
// The final receiver accepts only its registered partner and forwards only to
// its own fixed loopback control-AWG port. An intermediate relay sees ciphertext.
const net = require('node:net');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const MAX_FRAME = 2048;
const validKey = key => typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key)
  && Buffer.from(key, 'base64url').toString('base64url') === key;
const publicKey = key => crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: key } });
const sign = (value, secret) => crypto.sign(null, Buffer.from(JSON.stringify(value)), secret).toString('base64url');
const verify = (value, signature, key) => validKey(key) && typeof signature === 'string'
  && /^[A-Za-z0-9_-]{86}$/.test(signature)
  && crypto.verify(null, Buffer.from(JSON.stringify(value)), publicKey(key), Buffer.from(signature, 'base64url'));
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const helloBody = value => ['awg-easy-3/technical-hello/v1', value.key, value.challenge];
const openBody = value => [`awg-easy-3/technical-open/v${value.version}`, value.key, value.target,
  value.kind, value.server, value.challenge, value.nonce, value.origin,
  ...(value.version === 2 ? [value.locatorKey] : [])];
const ackBody = (hash, key) => ['awg-easy-3/technical-accepted/v1', hash, key];
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

class RelayFrames extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiter = null;
    this.failure = null;
    socket.on('error', () => this.fail());
    socket.on('close', () => this.fail());
    socket.on('data', bytes => {
      if (this.failure) return;
      if (this.buffer.length + bytes.length > 65536) { this.close(); return; }
      this.buffer = Buffer.concat([this.buffer, bytes]);
      while (this.buffer.length >= 2) {
        const size = this.buffer.readUInt16BE();
        if (!size || size > MAX_FRAME) { this.close(); return; }
        if (this.buffer.length < size + 2) break;
        const frame = Buffer.from(this.buffer.subarray(2, size + 2));
        this.buffer = this.buffer.subarray(size + 2);
        if (this.waiter) { const done = this.waiter; this.waiter = null; done(null, frame); }
        else {
          if (this.frames.length >= 16) { this.close(); return; }
          this.frames.push(frame);
        }
      }
    });
  }
  fail() {
    this.failure ||= new Error('Technical relay closed');
    this.frames = [];
    this.buffer = Buffer.alloc(0);
    if (this.waiter) { const done = this.waiter; this.waiter = null; done(this.failure); }
  }
  async read(timeoutMs = 60000) {
    if (this.frames.length) return this.frames.shift();
    if (this.failure) throw this.failure;
    if (this.waiter) throw new Error('Concurrent technical relay read');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.waiter = null; this.close(); reject(new Error('Technical relay timed out')); }, timeoutMs);
      this.waiter = (error, value) => { clearTimeout(timeout); if (error) reject(error); else resolve(value); };
    });
  }
  async write(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FRAME || this.failure
      || this.socket.writableLength > 65536) {
      this.close();
      throw new Error('Invalid technical relay frame');
    }
    const header = Buffer.alloc(2); header.writeUInt16BE(bytes.length);
    await new Promise((resolve, reject) => this.socket.write(Buffer.concat([header, bytes]), error => error ? reject(error) : resolve()));
  }
  async json(value) { await this.write(Buffer.from(JSON.stringify(value))); }
  async readJson() { return JSON.parse((await this.read(5000)).toString('utf8')); }
  close() { this.fail(); this.socket.destroy(); }
}

function validateOpen(value) {
  if (!exact(value, ['version', 'key', 'target', 'kind', 'server', 'challenge', 'nonce', 'origin', 'signature',
    ...(value?.version === 2 ? ['locatorKey'] : [])])
    || ![1, 2].includes(value.version) || value.version === 2 && !validKey(value.locatorKey)
    || ![value.key, value.target, value.server, value.challenge, value.nonce].every(validKey)
    || !['main', 'cell'].includes(value.kind)
    || !verify(openBody(value), value.signature, value.key)) throw new Error('Invalid technical relay proof');
  if (value.origin !== null) {
    // Exactly one intermediate is allowed. No relay loops or chained proxies.
    if (value.origin.origin !== null || value.origin.server !== value.key
      || value.origin.target !== value.target || value.origin.kind !== value.kind
      || (value.origin.locatorKey ?? null) !== (value.locatorKey ?? null)) {
      throw new Error('Invalid technical relay origin');
    }
    validateOpen(value.origin);
  }
  return value;
}

async function connectTechnicalRelay({ host, port, serverKey, identity, target, kind, origin = null, locatorKey }) {
  if (!validKey(serverKey) || !validKey(target) || !Number.isInteger(port)
    || port < 1 || port > 65535 || !net.isIP(host)) throw new Error('Invalid technical relay endpoint');
  const socket = net.connect({ host, port });
  socket.setTimeout(60000, () => socket.destroy());
  const frames = new RelayFrames(socket);
  try {
    const hello = await frames.readJson();
    if (!exact(hello, ['version', 'key', 'challenge', 'signature']) || hello.version !== 1
      || hello.key !== serverKey || !validKey(hello.challenge)
      || !verify(helloBody(hello), hello.signature, serverKey)) throw new Error('Technical relay identity mismatch');
    const request = { version: locatorKey === undefined ? 1 : 2, key: identity.publicKey, target, kind,
      ...(locatorKey === undefined ? {} : { locatorKey }),
      server: serverKey, challenge: hello.challenge, nonce: crypto.randomBytes(32).toString('base64url'), origin };
    request.signature = sign(openBody(request), identity.privateKey);
    await frames.json(request);
    const ack = await frames.readJson();
    if (!exact(ack, ['accepted', 'signature']) || ack.accepted !== true
      || !verify(ackBody(digest(request), serverKey), ack.signature, serverKey)) {
      throw new Error('Technical relay acknowledgement mismatch');
    }
    return frames;
  } catch (error) { frames.close(); throw error; }
}

// BEP5 yields an address, not an identity. A relay is untrusted: verify its
// self-signed challenge, then pin that key on the authenticated connection.
// This never substitutes its identity for the final registered AWG peer.
async function discoverRelayIdentity({ host, port }) {
  if (!publicRelayAddress(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid public technical relay');
  }
  const frames = new RelayFrames(net.connect({ host, port }));
  try {
    const hello = await frames.readJson();
    if (!exact(hello, ['version', 'key', 'challenge', 'signature']) || hello.version !== 1
      || !validKey(hello.challenge) || !verify(helloBody(hello), hello.signature, hello.key)) {
      throw new Error('Invalid public technical relay identity');
    }
    return hello.key;
  } finally { frames.close(); }
}

class AwgTechnicalRelay {
  constructor({ identity, kind, controlPort = null, allowedPeer, lookup,
    allowAddress = publicRelayAddress,
    maxConnections = 4, clock = () => performance.now() }) {
    if (!validKey(identity?.publicKey) || !['main', 'cell'].includes(kind)
      || controlPort !== null && (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535)
      || typeof allowedPeer !== 'function' || typeof lookup !== 'function'
      || !Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 8) {
      throw new TypeError('Invalid AWG technical relay configuration');
    }
    Object.assign(this, { identity, kind, controlPort, allowedPeer, lookup, allowAddress, maxConnections, clock });
    this.connections = new Set();
    this.tokens = 8192;
    this.last = clock();
    this.admissions = 4;
    this.admissionAt = clock();
    this.lookupAt = -Infinity;
    this.stats = { forwardedBytes: 0, droppedFrames: 0, rejectedConnections: 0 };
  }
  allow(bytes) {
    const now = this.clock();
    this.tokens = Math.min(8192, this.tokens + Math.max(0, now - this.last) * 8.192);
    this.last = Math.max(now, this.last);
    if (this.tokens < bytes) { this.stats.droppedFrames++; return false; }
    this.tokens -= bytes;
    this.stats.forwardedBytes += bytes;
    return true;
  }
  async start(port, host = '0.0.0.0') {
    this.server = net.createServer(socket => {
      const now = this.clock();
      this.admissions = Math.min(4, this.admissions + Math.max(0, now - this.admissionAt) / 1000);
      this.admissionAt = Math.max(now, this.admissionAt);
      if (this.connections.size >= this.maxConnections || this.admissions < 1) {
        this.stats.rejectedConnections++; socket.destroy(); return;
      }
      this.admissions--;
      const frames = new RelayFrames(socket);
      this.connections.add(frames);
      socket.setTimeout(60000, () => socket.destroy());
      this.handle(frames).catch(() => { this.stats.rejectedConnections++; })
        .finally(() => { this.connections.delete(frames); frames.close(); });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, resolve);
    });
    return this;
  }
  address() { return this.server.address(); }
  async handle(frames) {
    const hello = { version: 1, key: this.identity.publicKey,
      challenge: crypto.randomBytes(32).toString('base64url') };
    hello.signature = sign(helloBody(hello), this.identity.privateKey);
    await frames.json(hello);
    const request = validateOpen(await frames.readJson());
    if (request.challenge !== hello.challenge || request.server !== this.identity.publicKey) {
      throw new Error('Technical relay challenge mismatch');
    }
    const accepted = () => frames.json({ accepted: true,
      signature: sign(ackBody(digest(request), this.identity.publicKey), this.identity.privateKey) });
    if (request.target === this.identity.publicKey) {
      const origin = request.origin?.key || request.key;
      if (request.kind !== this.kind || this.controlPort === null
        || !await this.allowedPeer(origin)) throw new Error('Unregistered technical peer');
      frames.originKey = origin;
      const udp = dgram.createSocket('udp4');
      udp.on('error', () => frames.close());
      try {
        await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve); });
        udp.on('message', (bytes, peer) => {
          if (peer.address !== '127.0.0.1' || peer.port !== this.controlPort
            || bytes.length > MAX_FRAME || !this.allow(bytes.length)) return;
          frames.write(bytes).catch(() => frames.close());
        });
        await accepted();
        while (true) {
          const bytes = await frames.read();
          if (this.allow(bytes.length)) udp.send(bytes, this.controlPort, '127.0.0.1');
        }
      } finally { udp.close(); }
    } else {
      if (request.origin) throw new Error('A second technical relay is forbidden');
      if (this.clock() - this.lookupAt < 5000) throw new Error('Technical route lookup budget exhausted');
      this.lookupAt = this.clock();
      const contact = await this.lookup(request.locatorKey ?? request.target, request.kind);
      if (!contact || !this.allowAddress(contact.host)) throw new Error('No technical relay route');
      const outgoing = await connectTechnicalRelay({ host: contact.host, port: contact.port,
        serverKey: request.target, identity: this.identity, target: request.target,
        kind: request.kind, origin: request, locatorKey: request.locatorKey });
      try {
        await accepted();
        const pump = async (source, destination) => {
          while (true) { const bytes = await source.read(); if (this.allow(bytes.length)) await destination.write(bytes); }
        };
        await Promise.race([pump(frames, outgoing), pump(outgoing, frames)]);
      } finally { outgoing.close(); frames.close(); }
    }
  }
  async close() {
    for (const connection of this.connections) connection.close();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
  async refreshPeers() {
    for (const frames of this.connections) {
      if (frames.originKey && !await this.allowedPeer(frames.originKey)) frames.close();
    }
  }
}

async function openTechnicalBridge({ localAwgPort, localAwgAddress = '127.0.0.1', ...options }) {
  if (net.isIP(localAwgAddress) !== 4 || !Number.isInteger(localAwgPort) || localAwgPort < 1 || localAwgPort > 65535) {
    throw new TypeError('Owned local control-AWG port required');
  }
  const frames = await connectTechnicalRelay(options);
  const udp = dgram.createSocket('udp4');
  udp.on('error', () => frames.close());
  try {
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve); });
    udp.on('message', (bytes, peer) => {
      if (peer.address === localAwgAddress && peer.port === localAwgPort && bytes.length <= MAX_FRAME) {
        frames.write(bytes).catch(() => frames.close());
      }
    });
    let closed = false;
    const running = (async () => {
      try {
        while (!closed) { const bytes = await frames.read(); udp.send(bytes, localAwgPort, localAwgAddress); }
      } finally { frames.close(); if (!closed) { closed = true; udp.close(); } }
    })();
    running.catch(() => {});
    return { address: udp.address(), running, close: async () => {
      if (!closed) { closed = true; frames.close(); udp.close(); }
      await running.catch(() => {});
    } };
  } catch (error) { frames.close(); udp.close(); throw error; }
}

function publicRelayAddress(host) {
  if (net.isIP(host) !== 4) return false;
  const [a, b, c] = host.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2))
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113);
}

module.exports = { AwgTechnicalRelay, connectTechnicalRelay, openTechnicalBridge,
  discoverRelayIdentity, RelayFrames, validateOpen, publicRelayAddress };
