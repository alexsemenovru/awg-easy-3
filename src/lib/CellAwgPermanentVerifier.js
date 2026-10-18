'use strict';

const net = require('node:net');
const { runProcess } = require('./ProcessRunner');
const { validateKey } = require('./AwgKeyManager');
const { privateAddress } = require('./CellTunnelControlTransport');
const tunnelAddress = address => privateAddress(address)
  && !address.startsWith('127.') && address !== '::1';

function parseHandshake(text, peerPublicKey) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) {
    throw new Error('Invalid permanent AWG handshake inventory');
  }
  const rows = text.trim() ? text.trim().split(/\r?\n/) : [];
  if (rows.length > 128) throw new Error('Invalid permanent AWG handshake inventory');
  let found = null;
  for (const row of rows) {
    const parts = row.split('\t');
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) {
      throw new Error('Invalid permanent AWG handshake inventory');
    }
    validateKey(parts[0], 'handshakePeerKey');
    const seconds = Number(parts[1]);
    if (!Number.isSafeInteger(seconds)) throw new Error('Invalid permanent AWG handshake inventory');
    if (parts[0] === peerPublicKey) {
      if (found !== null) throw new Error('Duplicate permanent AWG peer');
      found = seconds;
    }
  }
  return found;
}

function probeControlTcp({ address, port, localAddress, timeoutMs = 3000 }) {
  return new Promise(resolve => {
    let done = false;
    const socket = net.connect({ host: address, port, localAddress });
    const finish = success => {
      if (done) return;
      done = true; socket.destroy(); resolve(success);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
    socket.once('connect', () => finish(true));
  });
}

// The caller retains its installation lock across verification and retirement.
// A successful TCP connect is a reachability test, not application auth; the
// signed control protocol still authenticates subsequent requests.
class CellAwgPermanentVerifier {
  constructor({ path, peerPublicKey, role, controlAddress, controlPort,
    localAddress, runner = runProcess, probe = probeControlTcp,
    now = Date.now, maxAgeSeconds = 120 }) {
    if (!path || typeof path.verifyOperational !== 'function'
      || !path.interfaceName || !/^[A-Za-z0-9_.-]{1,15}$/.test(path.interfaceName)
      || !['controller', 'cell'].includes(role) || !tunnelAddress(controlAddress)
      || !tunnelAddress(localAddress) || controlAddress === localAddress
      || net.isIP(controlAddress) !== net.isIP(localAddress)
      || !Number.isSafeInteger(controlPort) || controlPort < 1 || controlPort > 65535
      || typeof runner !== 'function' || typeof probe !== 'function'
      || typeof now !== 'function' || !Number.isSafeInteger(maxAgeSeconds)
      || maxAgeSeconds < 1 || maxAgeSeconds > 300) {
      throw new TypeError('Invalid permanent AWG verifier');
    }
    validateKey(peerPublicKey, 'permanentPeerPublicKey');
    Object.assign(this, { path, peerPublicKey, role, controlAddress, controlPort,
      localAddress, runner, probe, now, maxAgeSeconds });
  }

  async verify() {
    if (!await this.path.verifyOperational()) return false;
    // After a reboot AWG has no handshake until it sends a packet. Probing the
    // Cell's bound control TCP endpoint first initiates that handshake; the
    // fresh peer proof is still required immediately afterwards. Inspecting
    // freshness first would permanently prevent the Cell from reconnecting.
    if (this.role === 'cell' && !await this.probe({ address: this.controlAddress,
      port: this.controlPort, localAddress: this.localAddress })) return false;
    let output;
    try {
      output = (await this.runner('awg', ['show', this.path.interfaceName,
        'latest-handshakes'], { maxOutputBytes: 65536 })).stdout;
    } catch { throw new Error('Permanent AWG handshake inspection failed'); }
    const timestamp = parseHandshake(output, this.peerPublicKey);
    const nowSeconds = Math.floor(this.now() / 1000);
    if (timestamp === null || timestamp === 0 || !Number.isSafeInteger(nowSeconds)
      || nowSeconds < 0
      || timestamp > nowSeconds + 2 || nowSeconds - timestamp > this.maxAgeSeconds) return false;
    return true;
  }
}

module.exports = { CellAwgPermanentVerifier, parseHandshake, probeControlTcp };
