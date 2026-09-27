'use strict';

const net = require('node:net');
const { MAX_BYTES } = require('./CellRegistrationHandler');
const { verifyReceipt } = require('./CellRegistration');
const { listenControlOnTunnel, privateAddress } = require('./CellTunnelControlTransport');

// This listener must be started only after the temporary AWG peer and its
// port-specific guard are verified. It binds to a private tunnel address, not WAN.
function listenRegistrationOnTunnel({ address, port, handler, timeoutMs = 10000 }) {
  return listenControlOnTunnel({ address, port, handler, timeoutMs });
}

function registerOverTunnel({ address, port, controllerKey, request, timeoutMs = 10000 }) {
  if (!privateAddress(address) || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100) {
    throw new TypeError('Invalid private registration endpoint');
  }
  const bytes = Buffer.from(JSON.stringify(request) + '\n');
  if (bytes.length > MAX_BYTES + 1) return Promise.reject(new Error('Registration request too large'));
  return new Promise((resolve, reject) => {
    let settled = false, chunks = [], length = 0;
    const socket = net.connect({ host: address, port });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Registration connection timed out')), timeoutMs);
    timer.unref();
    socket.on('error', () => finish(new Error('Registration connection failed')));
    socket.on('close', () => finish(new Error('Registration connection closed')));
    socket.on('data', chunk => {
      if (settled) return;
      length += chunk.length;
      if (length > 2049) return finish(new Error('Registration response too large'));
      chunks.push(chunk);
      const frame = Buffer.concat(chunks, length);
      const end = frame.indexOf(10);
      if (end < 0) return;
      if (end !== frame.length - 1 || end > 2048) return finish(new Error('Invalid registration response'));
      try {
        const response = JSON.parse(frame.subarray(0, end).toString('utf8'));
        if (response.ok !== true) throw new Error('rejected');
        finish(null, verifyReceipt(response.receipt, request, controllerKey));
      } catch { finish(new Error('Registration confirmation rejected')); }
    });
    socket.once('connect', () => socket.write(bytes));
  });
}

module.exports = { listenRegistrationOnTunnel, registerOverTunnel };
