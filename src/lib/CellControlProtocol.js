'use strict';
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

function body(request) {
  const fields = ['version', 'controllerKey', 'cellKey', 'requestId', 'issuedAt', 'action', 'payload', 'signature'];
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !fields.includes(key)) || request.version !== 1
    || !['poll', 'ack'].includes(request.action) || typeof request.payload !== 'string'
    || Buffer.byteLength(request.payload) > 1024
    || !Number.isSafeInteger(request.issuedAt) || request.issuedAt < 0
    || !/^[a-f0-9]{32}$/.test(request.requestId)
    || ![request.cellKey, request.controllerKey].every(key => typeof key === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(key) && Buffer.from(key, 'base64url').toString('base64url') === key)) {
    throw new Error('Invalid control request');
  }
  return Buffer.from(JSON.stringify(['awg-easy-3/control/v1', request.controllerKey, request.cellKey,
    request.requestId, request.issuedAt, request.action, request.payload]));
}

function signControl({ controllerKey, action, payload = null }, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid control identity');
  const request = { version: 1, controllerKey, cellKey: crypto.createPublicKey(key).export({ format: 'jwk' }).x,
    requestId: crypto.randomBytes(16).toString('hex'), issuedAt: Date.now(), action, payload: JSON.stringify(payload) };
  return { ...request, signature: crypto.sign(null, body(request), key).toString('base64url') };
}

function verifyControl(bytes, controllerKey) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 2048) throw new Error('Control request too large');
  const request = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  const data = body(request);
  if (request.controllerKey !== controllerKey || request.issuedAt > Date.now()
    || Date.now() - request.issuedAt >= 300000 || typeof request.signature !== 'string'
    || !/^[A-Za-z0-9_-]{86}$/.test(request.signature)
    || Buffer.from(request.signature, 'base64url').toString('base64url') !== request.signature) throw new Error('Invalid control proof');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: request.cellKey } });
  if (!crypto.verify(null, data, key, Buffer.from(request.signature, 'base64url'))) throw new Error('Invalid control signature');
  const payload = JSON.parse(request.payload);
  if (request.action === 'poll' && payload !== null) throw new Error('Invalid poll');
  return { ...request, payload };
}

module.exports = { signControl, verifyControl };
