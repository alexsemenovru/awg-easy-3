'use strict';

// BEP 44 carries only a short-lived contact hint. It never authorizes a command.
const crypto = require('node:crypto');
const net = require('node:net');

const SALT = Buffer.from('awg-easy-3/cell-contact/v1');
const MAX_VALUE_BYTES = 512;
const MAX_LIFETIME_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const fail = () => { throw new Error('Invalid DHT Cell locator'); };
const exact = (value, fields) => value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const rawKey = key => typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key)
  && Buffer.from(key, 'base64url').length === 32
  && Buffer.from(key, 'base64url').toString('base64url') === key;

function validateValue(value, now) {
  if (!exact(value, ['version', 'kind', 'host', 'port', 'issuedAt', 'expiresAt'])
    || value.version !== 1 || value.kind !== 'cell'
    || typeof value.host !== 'string' || !net.isIP(value.host)
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt < 0 || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > MAX_LIFETIME_MS
    || value.issuedAt > now + MAX_CLOCK_SKEW_MS || value.expiresAt <= now) fail();
  return value;
}

function bstring(buffer) { return Buffer.concat([Buffer.from(`${buffer.length}:`), buffer]); }
function signatureBody(item) {
  // bencode dictionary keys are sorted: salt, seq, v. The outer d/e are omitted.
  return Buffer.concat([Buffer.from('4:salt'), bstring(SALT),
    Buffer.from(`3:seqi${item.seq}e1:v`), bstring(item.v)]);
}

function targetFor(cellKey) {
  if (!rawKey(cellKey)) fail();
  return crypto.createHash('sha1').update(Buffer.from(cellKey, 'base64url')).update(SALT).digest();
}

function createCellLocator({ privateKey, seq, host, port, now = Date.now() }) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(seq) || seq < 1) fail();
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') fail();
  const cellKey = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  const value = validateValue({ version: 1, kind: 'cell', host, port,
    issuedAt: now, expiresAt: now + MAX_LIFETIME_MS }, now);
  const v = Buffer.from(JSON.stringify(value));
  if (v.length > MAX_VALUE_BYTES) fail();
  const k = Buffer.from(cellKey, 'base64url');
  return Object.freeze({ k, salt: Buffer.from(SALT), seq, v,
    sign: message => crypto.sign(null, message, key) });
}

function verifyCellLocator(item, { cellKey, minimumSeq = 0, now = Date.now() }) {
  if (!rawKey(cellKey) || !item || !Buffer.isBuffer(item.k)
    || !item.k.equals(Buffer.from(cellKey, 'base64url'))
    || !Buffer.isBuffer(item.salt) || !item.salt.equals(SALT)
    || !Buffer.isBuffer(item.v) || item.v.length > MAX_VALUE_BYTES
    || !Buffer.isBuffer(item.sig) || item.sig.length !== 64
    || !Number.isSafeInteger(item.seq) || item.seq < 1
    || !Number.isSafeInteger(minimumSeq) || item.seq < minimumSeq
    || !Number.isSafeInteger(now) || now < 0) fail();
  const publicKey = crypto.createPublicKey({ format: 'jwk',
    key: { kty: 'OKP', crv: 'Ed25519', x: cellKey } });
  if (!crypto.verify(null, signatureBody(item), publicKey, item.sig)) fail();
  let value;
  try { value = JSON.parse(item.v.toString('utf8')); } catch { fail(); }
  validateValue(value, now);
  if (!Buffer.from(JSON.stringify(value)).equals(item.v)) fail();
  return Object.freeze({ cellKey, seq: item.seq, host: value.host, port: value.port,
    expiresAt: value.expiresAt, target: targetFor(cellKey) });
}

module.exports = { targetFor, createCellLocator, verifyCellLocator };
