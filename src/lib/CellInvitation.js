'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const MAX_CODE_LENGTH = 2048;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[a-f0-9]{32}$/;
const fail = () => { throw new Error('Invalid or unavailable cell invitation'); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const validToken = value => typeof value === 'string' && tokenPattern.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const validHost = value => typeof value === 'string' && value.length <= 253
  && (net.isIP(value) !== 0 || value.split('.').every(label =>
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)));

function validatePayload(value) {
  if (!value || value.version !== 1 || value.kind !== 'cell-invitation'
    || !idPattern.test(value.id) || !validToken(value.secret)
    || !validToken(value.controllerKey) || !validHost(value.host)
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || !validTime(value.expiresAt)) fail();
  return { version: 1, kind: 'cell-invitation', id: value.id, host: value.host,
    port: value.port, controllerKey: value.controllerKey,
    secret: value.secret, expiresAt: value.expiresAt };
}

function createInvitation({ host, port, controllerKey, now = Date.now(), lifetimeMs = 900000 }) {
  if (!validTime(now) || !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0
    || lifetimeMs > MAX_LIFETIME_MS) fail();
  const payload = validatePayload({ version: 1, kind: 'cell-invitation',
    id: crypto.randomBytes(16).toString('hex'), host, port, controllerKey,
    secret: crypto.randomBytes(32).toString('base64url'), expiresAt: now + lifetimeMs });
  return {
    code: Buffer.from(JSON.stringify(payload)).toString('base64url'),
    record: { version: 1, id: payload.id, status: 'pending', createdAt: now,
      expiresAt: payload.expiresAt, secretHash: digest(payload.secret) },
  };
}

function decodeInvitation(code, now = Date.now()) {
  if (!validTime(now) || typeof code !== 'string' || code.length > MAX_CODE_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(code)) fail();
  const bytes = Buffer.from(code, 'base64url');
  if (bytes.toString('base64url') !== code) fail();
  let payload;
  try { payload = validatePayload(JSON.parse(bytes.toString('utf8'))); } catch { fail(); }
  if (payload.expiresAt <= now) fail();
  return payload;
}

function authenticate(record, secret, now) {
  if (!record || record.version !== 1 || !idPattern.test(record.id)
    || !validTime(now) || !validTime(record.createdAt) || !validTime(record.expiresAt)
    || record.createdAt > now || record.expiresAt <= now
    || !validToken(secret) || !/^[a-f0-9]{64}$/.test(record.secretHash)) fail();
  if (!crypto.timingSafeEqual(Buffer.from(record.secretHash, 'hex'), Buffer.from(digest(secret), 'hex'))) fail();
}

// Invoke only after the transport has checked proof of possession of cellKey.
// Caller must serialize and durably commit this result before replying.
function completeInvitation(record, { secret, requestId, cellKey, registrationValid }, now = Date.now()) {
  authenticate(record, secret, now);
  if (record.status === 'consumed' && registrationValid === true
    && record.requestId === requestId && record.cellKey === cellKey) return { ...record };
  if (record.status !== 'pending') fail();
  if (registrationValid !== true || !idPattern.test(requestId) || !validToken(cellKey)) {
    return { ...record, status: 'blocked', changedAt: now };
  }
  return { ...record, status: 'consumed', requestId, cellKey, changedAt: now };
}

function revokeInvitation(record, now = Date.now()) {
  if (!record || record.version !== 1 || !idPattern.test(record.id)
    || !validTime(now) || !validTime(record.createdAt) || now < record.createdAt
    || !['pending', 'blocked', 'revoked'].includes(record.status)) fail();
  return record.status === 'revoked' ? { ...record } : { ...record, status: 'revoked', changedAt: now };
}

module.exports = { createInvitation, decodeInvitation, completeInvitation, revokeInvitation };
