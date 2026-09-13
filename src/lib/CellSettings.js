'use strict';

const crypto = require('node:crypto');
const MAX_PAYLOAD = 256 * 1024;
const token = (value, size) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
  && Buffer.from(value, 'base64url').length === size
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const fail = () => { throw new Error('Invalid cell settings envelope'); };

function bytes(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !token(value.controllerKey, 32) || !token(value.cellKey, 32)
    || typeof value.payload !== 'string' || Buffer.byteLength(value.payload) > MAX_PAYLOAD) fail();
  return Buffer.from(JSON.stringify(['awg-easy-3/cell-settings/v1', value.controllerKey,
    value.cellKey, value.revision, value.payload]));
}

function signSettings({ cellKey, revision, settings }, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') fail();
  const envelope = { version: 1, controllerKey: crypto.createPublicKey(key).export({ format: 'jwk' }).x,
    cellKey, revision, payload: JSON.stringify(settings) };
  return { ...envelope, signature: crypto.sign(null, bytes(envelope), key).toString('base64url') };
}

function verifySettings(envelope, { controllerKey, cellKey }) {
  const data = bytes(envelope);
  if (envelope.controllerKey !== controllerKey || envelope.cellKey !== cellKey
    || !token(envelope.signature, 64)) fail();
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: controllerKey } });
  if (!crypto.verify(null, data, key, Buffer.from(envelope.signature, 'base64url'))) fail();
  let settings;
  try { settings = JSON.parse(envelope.payload); } catch { fail(); }
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') fail();
  return { settings, hash: crypto.createHash('sha256').update(data).digest('hex') };
}

module.exports = { signSettings, verifySettings };
