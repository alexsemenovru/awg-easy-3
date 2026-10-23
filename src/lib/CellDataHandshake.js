'use strict';

const { runProcess } = require('./ProcessRunner');
const { validateKey } = require('./AwgKeyManager');
const { parseHandshake } = require('./CellAwgPermanentVerifier');

// Cell sends AWG keepalives over the public UDP socket while the data
// interface's inner traffic is still blocked by the durable nft guard.
// A fresh authenticated handshake proves the peer path without opening user
// traffic or relying on a TCP listener inside the data tunnel.
async function verifyCellDataHandshake({ interfaceName, peerPublicKey,
  runner = runProcess, now = Date.now, maxAgeSeconds = 120 } = {}) {
  if (typeof interfaceName !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(interfaceName)
    || typeof runner !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1
    || maxAgeSeconds > 300) throw new TypeError('Invalid data handshake verifier');
  validateKey(peerPublicKey, 'dataPeerPublicKey');
  let output;
  try {
    output = (await runner('awg', ['show', interfaceName, 'latest-handshakes'],
      { maxOutputBytes: 65536 })).stdout;
  } catch { throw new Error('Data AWG handshake inspection failed'); }
  const timestamp = parseHandshake(output, peerPublicKey);
  const seconds = Math.floor(now() / 1000);
  return timestamp !== null && timestamp !== 0 && Number.isSafeInteger(seconds)
    && seconds >= 0 && timestamp <= seconds + 2
    && seconds - timestamp <= maxAgeSeconds;
}

module.exports = { verifyCellDataHandshake };
