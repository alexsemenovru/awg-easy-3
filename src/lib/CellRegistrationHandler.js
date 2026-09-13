'use strict';

const { TextDecoder } = require('node:util');
const MAX_BYTES = 2048;
const fields = ['version', 'invitationId', 'requestId', 'controllerKey', 'cellKey',
  'secret', 'issuedAt', 'signature'].sort();
const encoded = (value, size) => typeof value === 'string'
  && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').length === size
  && Buffer.from(value, 'base64url').toString('base64url') === value;

function parseRegistration(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw new Error('Invalid registration message');
  }
  const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!request || Array.isArray(request) || typeof request !== 'object'
    || JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(fields)
    || request.version !== 1 || !Number.isSafeInteger(request.issuedAt) || request.issuedAt < 0
    || !['invitationId', 'requestId'].every(name => typeof request[name] === 'string'
      && /^[a-f0-9]{32}$/.test(request[name]))
    || !['controllerKey', 'cellKey', 'secret'].every(name => encoded(request[name], 32))
    || !encoded(request.signature, 64)) throw new Error('Invalid registration message');
  return request;
}

// One instance per controller, shared by direct and future relay transports.
// Caller must bound bytes and connection lifetime BEFORE buffering a network body.
// This component must never be attached to a plaintext public listener.
class CellRegistrationHandler {
  constructor(service, { maxInFlight = 4, burst = 16, refillMs = 1000,
    monotonicNow = () => performance.now() } = {}) {
    if (![maxInFlight, burst, refillMs].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError('Invalid registration limits');
    }
    this.service = service;
    this.maxInFlight = maxInFlight;
    this.burst = burst;
    this.refillMs = refillMs;
    this.monotonicNow = monotonicNow;
    this.tokens = burst;
    this.last = monotonicNow();
    this.inFlight = 0;
  }

  async handle(bytes) {
    const now = this.monotonicNow();
    if (!Number.isFinite(now)) return { ok: false, error: 'registration_unavailable' };
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.last) / this.refillMs);
    this.last = Math.max(this.last, now);
    if (this.tokens < 1 || this.inFlight >= this.maxInFlight) {
      return { ok: false, error: 'registration_busy' };
    }
    this.tokens -= 1;
    this.inFlight += 1;
    try {
      const request = parseRegistration(bytes);
      const receipt = await this.service.register(request);
      return { ok: true, receipt };
    } catch {
      // Do not expose filesystem paths, secrets, or invitation existence.
      return { ok: false, error: 'registration_unavailable' };
    } finally {
      this.inFlight -= 1;
    }
  }
}

module.exports = { CellRegistrationHandler, parseRegistration, MAX_BYTES };
