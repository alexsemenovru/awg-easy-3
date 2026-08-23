'use strict';

const crypto = require('node:crypto');

const TOKEN_VERSION = 1;

const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

const safeEqual = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

class SessionManager {
  constructor({
    store,
    clock = () => Date.now(),
    randomBytes = crypto.randomBytes,
    lifetimeMs = 12 * 60 * 60 * 1000,
  } = {}) {
    if (!store || typeof store.load !== 'function') throw new TypeError('store must provide load');
    if (typeof clock !== 'function' || typeof randomBytes !== 'function') {
      throw new TypeError('clock and randomBytes must be functions');
    }
    if (!Number.isInteger(lifetimeMs) || lifetimeMs < 60_000 || lifetimeMs > 30 * 24 * 60 * 60 * 1000) {
      throw new TypeError('lifetimeMs must be between one minute and thirty days');
    }
    this.store = store;
    this.clock = clock;
    this.randomBytes = randomBytes;
    this.lifetimeMs = lifetimeMs;
  }

  async secret() {
    const state = await this.store.load();
    if (!state) throw new Error('AWG-Easy 3 is not initialized');
    return state.auth.sessionSecret;
  }

  async create() {
    const issuedAt = this.clock();
    const claims = {
      v: TOKEN_VERSION,
      iat: issuedAt,
      exp: issuedAt + this.lifetimeMs,
      sid: this.randomBytes(18).toString('base64url'),
    };
    const payload = encode(claims);
    return `${payload}.${sign(payload, await this.secret())}`;
  }

  async verify(token) {
    if (typeof token !== 'string' || token.length > 2048) return false;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false;
    const [payload, signature] = parts;
    const expected = sign(payload, await this.secret());
    if (!safeEqual(signature, expected)) return false;

    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    const now = this.clock();
    return Boolean(
      claims && claims.v === TOKEN_VERSION
      && Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp)
      && typeof claims.sid === 'string' && claims.sid.length >= 16
      && claims.iat <= now + 60_000
      && claims.exp > now
      && claims.exp - claims.iat === this.lifetimeMs,
    );
  }

  cookie(token, { secure = false } = {}) {
    if (typeof token !== 'string' || /[\s;,]/.test(token)) throw new TypeError('Invalid session token');
    return [
      `awg_easy_3_session=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(this.lifetimeMs / 1000)}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ');
  }

  clearCookie({ secure = false } = {}) {
    return [
      'awg_easy_3_session=',
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
      ...(secure ? ['Secure'] : []),
    ].join('; ');
  }
}

module.exports = { SessionManager, TOKEN_VERSION };
