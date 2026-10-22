'use strict';

const net = require('node:net');
const { verifyControlReply } = require('./CellControlProtocol');

const REQUEST_LIMIT = 2304;
const RESPONSE_LIMIT = 2 * 1024 * 1024;

// Binding to a tunnel address is mandatory; this module must never expose the
// unauthenticated transport on a public interface. Runtime integration must also
// verify that the address belongs to the owned inter-server AWG interface.
function privateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 168;
  }
  if (family === 6) {
    if (address === '::1') return true;
    const first = parseInt(address.split(':')[0], 16);
    return Number.isInteger(first) && (first & 0xfe00) === 0xfc00;
  }
  return false;
}

function requireTunnelAddress(address) {
  if (!privateAddress(address)) throw new TypeError('Control address must be private');
}

function validPort(port, allowEphemeral = false) {
  if (!Number.isSafeInteger(port) || port < (allowEphemeral ? 0 : 1) || port > 65535) {
    throw new TypeError('Invalid control port');
  }
}

function readLine(socket, limit, onLine) {
  let chunks = [];
  let length = 0;
  let done = false;
  socket.on('data', chunk => {
    if (done) return socket.destroy();
    length += chunk.length;
    if (length > limit + 1) return socket.destroy();
    chunks.push(chunk);
    const data = Buffer.concat(chunks, length);
    const end = data.indexOf(10);
    if (end < 0) return;
    if (end !== data.length - 1 || end > limit) return socket.destroy();
    done = true;
    chunks = [];
    onLine(data.subarray(0, end));
  });
}

async function listenControlOnTunnel({ address, port, handler, timeoutMs = 10000,
  maxConnections = 16 }) {
  requireTunnelAddress(address);
  validPort(port, true);
  if (!handler || typeof handler.handle !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100
    || !Number.isSafeInteger(maxConnections) || maxConnections < 1) {
    throw new TypeError('Invalid control listener');
  }
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    readLine(socket, REQUEST_LIMIT, async bytes => {
      try {
        const response = await handler.handle(bytes);
        if (!socket.destroyed) socket.end(JSON.stringify(response) + '\n');
      } catch { socket.destroy(); }
    });
  });
  server.maxConnections = maxConnections;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: address, port }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server;
  } catch (error) {
    if (server.listening) server.close();
    throw error;
  }
}

function exchangeOverTunnel({ address, port, request, controllerKey, timeoutMs = 10000 }) {
  requireTunnelAddress(address);
  validPort(port);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new TypeError('Invalid control timeout');
  const bytes = Buffer.from(JSON.stringify(request) + '\n');
  if (bytes.length > REQUEST_LIMIT + 1) return Promise.reject(new Error('Control request too large'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host: address, port });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Control connection timed out')), timeoutMs);
    timer.unref();
    socket.on('error', () => finish(new Error('Control connection failed')));
    socket.on('close', () => finish(new Error('Control connection closed')));
    readLine(socket, RESPONSE_LIMIT, frame => {
      try {
        const reply = JSON.parse(frame.toString('utf8'));
        if (reply.ok !== true) throw new Error('Control request rejected');
        finish(null, verifyControlReply(reply, controllerKey, request.requestId));
      } catch { finish(new Error('Control reply rejected')); }
    });
    socket.once('connect', () => socket.write(bytes));
  });
}

module.exports = { listenControlOnTunnel, exchangeOverTunnel, privateAddress };
