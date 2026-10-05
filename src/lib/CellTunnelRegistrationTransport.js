'use strict';

const net = require('node:net');
const { CellRegistrationHandler, MAX_BYTES } = require('./CellRegistrationHandler');
const { verifyReceipt } = require('./CellRegistration');
const { verifyAwgReceipt, parseAwgRegistration } = require('./CellAwgRegistration');
const { CellAwgRegistrationService } = require('./CellAwgRegistrationService');
const { requireOwnedTunnelAddress } = require('./CellOwnedTunnel');
const { listenControlOnTunnel, privateAddress } = require('./CellTunnelControlTransport');

// This listener must be started only after the temporary AWG peer and its
// port-specific guard are verified. It binds to a private tunnel address, not WAN.
function listenRegistrationOnTunnel({ address, port, handler, timeoutMs = 10000 }) {
  return listenControlOnTunnel({ address, port, handler, timeoutMs });
}

// v2 entry point: only bind after both the owned AWG device and the caller's
// bootstrap peer/firewall readback are ready. Legacy v1 uses the generic helper.
async function listenAwgRegistrationOnTunnel({ address, port, lifecycle, identityStore,
  bootstrapStore, bootstrapRuntime, timeoutMs = 10000 }) {
  if (!bootstrapStore || typeof bootstrapStore.completeAwgSigned !== 'function'
    || !identityStore || typeof identityStore.load !== 'function'
    || !bootstrapRuntime || typeof bootstrapRuntime.verifyCurrent !== 'function') {
    throw new TypeError('AWG registration requires identity, store and bootstrap runtime');
  }
  if (bootstrapRuntime.store !== bootstrapStore || bootstrapRuntime.lifecycle !== lifecycle
    || bootstrapRuntime.controllerAddress !== address || bootstrapRuntime.registrationPort !== port) {
    throw new Error('AWG registration listener differs from verified bootstrap runtime');
  }
  await requireOwnedTunnelAddress({ lifecycle, address });
  if (await bootstrapRuntime.verifyCurrent() !== true) throw new Error('AWG bootstrap path is not verified');
  const handler = new CellRegistrationHandler(
    new CellAwgRegistrationService(identityStore, bootstrapStore),
    { parse: parseAwgRegistration });
  return listenRegistrationOnTunnel({ address, port, handler, timeoutMs });
}

function connectRegistration({ address, port, controllerKey, request, timeoutMs = 10000 }, verify) {
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
        finish(null, verify(response.receipt, request, controllerKey));
      } catch { finish(new Error('Registration confirmation rejected')); }
    });
    socket.once('connect', () => socket.write(bytes));
  });
}

const registerOverTunnel = options => connectRegistration(options, verifyReceipt);
const registerAwgOverTunnel = options => connectRegistration(options, verifyAwgReceipt);

module.exports = { listenRegistrationOnTunnel, listenAwgRegistrationOnTunnel,
  registerOverTunnel, registerAwgOverTunnel };
