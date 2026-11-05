'use strict';

const { EventEmitter } = require('node:events');
const dgram = require('node:dgram');

// Injected using bittorrent-dht's socket option. Drop before bencode/crypto;
// never queue traffic behind the user VPN or retain remote addresses in stats.
class DhtBudgetSocket extends EventEmitter {
  constructor({ socket = dgram.createSocket('udp4'), bytesPerSecond = 8192,
    packetsPerSecond = 32, maxDatagramBytes = 2048,
    clock = () => performance.now() } = {}) {
    super();
    if (![bytesPerSecond, packetsPerSecond, maxDatagramBytes].every(Number.isSafeInteger)
      || bytesPerSecond < 1024 || bytesPerSecond > 65536
      || packetsPerSecond < 1 || packetsPerSecond > 128
      || maxDatagramBytes < 1024 || maxDatagramBytes > 4096
      || typeof clock !== 'function') throw new TypeError('Invalid DHT socket budget');
    Object.assign(this, { socket, bytesPerSecond, packetsPerSecond, maxDatagramBytes, clock });
    this.buckets = new Map();
    this.counters = { receivedBytes: 0, sentBytes: 0, droppedIn: 0, droppedOut: 0 };
    socket.on('message', (bytes, peer) => {
      if (!this.allow('in', bytes.byteLength)) { this.counters.droppedIn++; return; }
      this.counters.receivedBytes += bytes.byteLength;
      this.emit('message', bytes, peer);
    });
    socket.on('error', error => this.emit('error', error));
    socket.on('close', () => this.emit('close'));
    socket.on('listening', () => {
      // Bound kernel buffers too; socket implementation may not expose these.
      socket.setRecvBufferSize?.(65536);
      socket.setSendBufferSize?.(32768);
      this.emit('listening');
    });
  }

  allow(direction, length) {
    if (!Number.isSafeInteger(length) || length < 1 || length > this.maxDatagramBytes) return false;
    const now = this.clock();
    const bucket = this.buckets.get(direction) || {
      time: now, bytes: this.bytesPerSecond, packets: this.packetsPerSecond,
    };
    const elapsed = Math.max(0, now - bucket.time) / 1000;
    bucket.time = now;
    bucket.bytes = Math.min(this.bytesPerSecond, bucket.bytes + elapsed * this.bytesPerSecond);
    bucket.packets = Math.min(this.packetsPerSecond, bucket.packets + elapsed * this.packetsPerSecond);
    this.buckets.set(direction, bucket);
    if (bucket.bytes < length + 28 || bucket.packets < 1) return false;
    bucket.bytes -= length + 28;
    bucket.packets--;
    return true;
  }

  send(bytes, offset, length, port, host, callback) {
    if (!this.allow('out', length)) {
      this.counters.droppedOut++;
      if (callback) queueMicrotask(() => callback(Object.assign(new Error('DHT budget exceeded'), { code: 'EAGAIN' })));
      return;
    }
    this.counters.sentBytes += length;
    this.socket.send(bytes, offset, length, port, host, callback);
  }

  bind(...args) { this.socket.bind(...args); return this; }
  address() { return this.socket.address(); }
  close(callback) { if (callback) this.once('close', callback); this.socket.close(); return this; }
  ref() { this.socket.ref(); return this; }
  unref() { this.socket.unref(); return this; }
  stats() { return Object.freeze({ ...this.counters }); }
}

module.exports = { DhtBudgetSocket };
