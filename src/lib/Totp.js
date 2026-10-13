'use strict';

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;

const encodeBase32 = (bytes) => {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(value >>> (bits -= 5)) & 31];
    }
  }
  if (bits) result += ALPHABET[(value << (5 - bits)) & 31];
  return result;
};

const decodeBase32 = (secret) => {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{32,}$/.test(secret)) throw new TypeError('Invalid TOTP secret');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits -= 8)) & 255);
    }
  }
  return Buffer.from(bytes);
};

const generateSecret = (randomBytes = crypto.randomBytes) => encodeBase32(randomBytes(20));

const codeAt = (secret, step) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[19] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
};

const matchingStep = (secret, code, now = Date.now(), lastUsedStep = -1) => {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / (PERIOD * 1000));
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0 || step <= lastUsedStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
};

const provisioningUri = (secret) => `otpauth://totp/${encodeURIComponent('AWG-Easy 3:Admin')}?secret=${secret}&issuer=${encodeURIComponent('AWG-Easy 3')}&algorithm=SHA1&digits=6&period=${PERIOD}`;

module.exports = { PERIOD, codeAt, decodeBase32, generateSecret, matchingStep, provisioningUri };
