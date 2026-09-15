'use strict';

const tls = require('node:tls');
const crypto = require('node:crypto');
const { MAX_BYTES } = require('./CellRegistrationHandler');
const { verifyReceipt } = require('./CellRegistration');
const ALPN = 'awg-easy-3-registration/1';

function readFrame(socket, limit, receive) {
  let buffer = Buffer.alloc(0);
  let done = false;
  socket.on('data', chunk => {
    if (done || buffer.length + chunk.length > limit + 1) return socket.destroy();
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf(10);
    if (end < 0) return;
    if (end !== buffer.length - 1 || end > limit) return socket.destroy();
    done = true;
    receive(buffer.subarray(0, end));
  });
}

// Does not listen automatically. Certificate must use the controller identity key.
function createRegistrationServer({ key, cert, handler, timeoutMs = 10000, maxConnections = 16, protocol = ALPN }) {
  const server = tls.createServer({ key, cert, minVersion: 'TLSv1.3',
    ALPNProtocols: [protocol], handshakeTimeout: timeoutMs }, socket => {
    socket.on('error', () => {});
    if (socket.alpnProtocol !== protocol) return socket.destroy();
    readFrame(socket, MAX_BYTES, async bytes => {
      try {
        const response = await handler.handle(bytes);
        if (!socket.destroyed) socket.end(JSON.stringify(response) + '\n');
      } catch { socket.destroy(); }
    });
  });
  server.maxConnections = maxConnections;
  server.on('connection', socket => {
    // Absolute deadline, not reset by trickling bytes; covers TLS handshake too.
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  });
  server.on('tlsClientError', () => {});
  return server;
}

function exchangeOverTls({ host, port, controllerKey, request, timeoutMs = 10000,
  protocol = ALPN, responseLimit = 2048, verifyResponse }) {
  const bytes = Buffer.from(JSON.stringify(request) + '\n');
  if (bytes.length > MAX_BYTES + 1) return Promise.reject(new Error('Registration request too large'));
  return new Promise((resolve, reject) => {
    let settled = false;
    // Trust is the invitation's Ed25519 key, not a public CA or hostname.
    // No application bytes are written before secureConnect + explicit pin check.
    const socket = tls.connect({ host, port, minVersion: 'TLSv1.3', rejectUnauthorized: false,
      ALPNProtocols: [protocol] });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Registration connection timed out')), timeoutMs);
    socket.on('error', () => finish(new Error('Registration connection failed')));
    socket.on('close', () => finish(new Error('Registration connection closed')));
    socket.once('secureConnect', () => {
      try {
        const certificate = new crypto.X509Certificate(socket.getPeerCertificate().raw);
        const peer = certificate.publicKey;
        if (socket.alpnProtocol !== protocol || peer.asymmetricKeyType !== 'ed25519'
          || peer.export({ format: 'jwk' }).x !== controllerKey) throw new Error('pin');
        readFrame(socket, responseLimit, frame => {
          try {
            const response = JSON.parse(frame.toString('utf8'));
            if (response.ok !== true) throw new Error('rejected');
            finish(null, verifyResponse(response));
          } catch { finish(new Error('Registration confirmation rejected')); }
        });
        socket.write(bytes);
      } catch { finish(new Error('Controller identity verification failed')); }
    });
  });
}

function registerOverTls(options) {
  return exchangeOverTls({ ...options,
    verifyResponse: response => verifyReceipt(response.receipt, options.request, options.controllerKey) });
}

module.exports = { createRegistrationServer, registerOverTls, exchangeOverTls };
