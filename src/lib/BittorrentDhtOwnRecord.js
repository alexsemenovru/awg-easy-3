'use strict';

const { locatorSignatureBody, verifyCellLocator, targetFor } = require('./CellDhtLocator');

// Pinned bittorrent-dht 11.0.12 retains immutable puts locally, but not mutable
// puts. Its public put() alone leaves a live owner undiscoverable after the
// storage peer disappears. Isolate that version-specific cache bridge here.
// The real-UDP restart test must pass before upgrading the pinned dependency.
function retainOwnRecord(dht, options, { publicKey, kind, now = Date.now() }) {
  if (!dht?._values || typeof dht._values.set !== 'function'
    || !Buffer.isBuffer(dht.nodeId) || dht.nodeId.length !== 20) {
    throw new Error('Unsupported DHT local mutable cache');
  }
  const item = { k: options.k, salt: options.salt, seq: options.seq,
    v: options.v, sig: options.sign(locatorSignatureBody(options)) };
  verifyCellLocator(item, { cellKey: publicKey, kind, now });
  dht._values.set(targetFor(publicKey).toString('hex'), { ...item, id: dht.nodeId });
}

module.exports = { retainOwnRecord };
