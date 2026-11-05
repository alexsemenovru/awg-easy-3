'use strict';
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { MAX_CLOCK_SKEW_MS } = require('./CellClock');

function body(request) {
  const fields = ['version', 'controllerKey', 'cellKey', 'requestId', 'issuedAt', 'action', 'payload', 'signature'];
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !fields.includes(key)) || request.version !== 1
    || !['poll', 'ack', 'announce', 'announce-data', 'offer-data', 'route', 'route-ack',
      'backup', 'backup-ack'].includes(request.action) || typeof request.payload !== 'string'
    || Buffer.byteLength(request.payload) > 1536
    || !Number.isSafeInteger(request.issuedAt) || request.issuedAt < 0
    || !/^[a-f0-9]{32}$/.test(request.requestId)
    || ![request.cellKey, request.controllerKey].every(key => typeof key === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(key) && Buffer.from(key, 'base64url').toString('base64url') === key)) {
    throw new Error('Invalid control request');
  }
  return Buffer.from(JSON.stringify(['awg-easy-3/control/v1', request.controllerKey, request.cellKey,
    request.requestId, request.issuedAt, request.action, request.payload]));
}

function signControl({ controllerKey, action, payload = null }, privateKey, now = Date.now()) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid control identity');
  const request = { version: 1, controllerKey, cellKey: crypto.createPublicKey(key).export({ format: 'jwk' }).x,
    requestId: crypto.randomBytes(16).toString('hex'), issuedAt: now, action, payload: JSON.stringify(payload) };
  return { ...request, signature: crypto.sign(null, body(request), key).toString('base64url') };
}

function verifyControl(bytes, controllerKey, now = Date.now()) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 2304) throw new Error('Control request too large');
  const request = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  const data = body(request);
  if (!Number.isSafeInteger(now) || request.controllerKey !== controllerKey || request.issuedAt - now > MAX_CLOCK_SKEW_MS
    || now - request.issuedAt >= 300000 || typeof request.signature !== 'string'
    || !/^[A-Za-z0-9_-]{86}$/.test(request.signature)
    || Buffer.from(request.signature, 'base64url').toString('base64url') !== request.signature) throw new Error('Invalid control proof');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: request.cellKey } });
  if (!crypto.verify(null, data, key, Buffer.from(request.signature, 'base64url'))) throw new Error('Invalid control signature');
  const payload = JSON.parse(request.payload);
  if (['offer-data', 'route', 'backup'].includes(request.action) && payload !== null) throw new Error('Invalid control poll');
  if (request.action === 'poll' && payload !== null && (!payload || typeof payload !== 'object'
    || Object.keys(payload).join(',') !== 'controlPath'
    || !['direct', 'technical'].includes(payload.controlPath))) throw new Error('Invalid control observation');
  return { ...request, payload };
}

function replyBody(reply) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)
    || reply.ok !== true || !/^[a-f0-9]{32}$/.test(reply.requestId)
    || ['settings', 'applied', 'announced', 'offer', 'routing', 'backup'].filter(key => Object.hasOwn(reply, key)).length !== 1
    || (Object.hasOwn(reply, 'settings') && reply.settings !== null
      && (typeof reply.settings !== 'object' || Array.isArray(reply.settings)))
    || (Object.hasOwn(reply, 'applied') && (!Number.isSafeInteger(reply.applied) || reply.applied < 1))
    || (Object.hasOwn(reply, 'announced') && reply.announced !== true)) {
    throw new Error('Invalid control reply');
  }
  if (Object.hasOwn(reply, 'offer') && reply.offer !== null
    && (typeof reply.offer !== 'object' || Array.isArray(reply.offer)
      || Buffer.byteLength(JSON.stringify(reply.offer)) > 8192)) {
    throw new Error('Invalid control offer envelope');
  }
  if (Object.hasOwn(reply, 'routing') && reply.routing !== null
    && (typeof reply.routing !== 'object' || Array.isArray(reply.routing)
      || Buffer.byteLength(JSON.stringify(reply.routing)) > 1024 * 1024)) {
    throw new Error('Invalid control routing envelope');
  }
  if (Object.hasOwn(reply, 'backup') && reply.backup !== null
    && (typeof reply.backup !== 'object' || Array.isArray(reply.backup)
      || Buffer.byteLength(JSON.stringify(reply.backup)) > 2048)) throw new Error('Invalid backup grant envelope');
  const kind = ['settings', 'applied', 'announced', 'offer', 'routing', 'backup'].find(key => Object.hasOwn(reply, key));
  const fields = ['ok', 'requestId', kind, 'signature'];
  if (Object.keys(reply).some(key => !fields.includes(key))) throw new Error('Invalid control reply');
  return Buffer.from(JSON.stringify(['awg-easy-3/control-reply/v1', reply.requestId,
    kind, reply[kind]]));
}

function signControlReply(reply, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid controller identity');
  return { ...reply, signature: crypto.sign(null, replyBody(reply), key).toString('base64url') };
}

function verifyControlReply(reply, controllerKey, requestId) {
  const data = replyBody(reply);
  if (reply.requestId !== requestId || typeof reply.signature !== 'string'
    || !/^[A-Za-z0-9_-]{86}$/.test(reply.signature)
    || Buffer.from(reply.signature, 'base64url').toString('base64url') !== reply.signature
    || !/^[A-Za-z0-9_-]{43}$/.test(controllerKey)
    || Buffer.from(controllerKey, 'base64url').toString('base64url') !== controllerKey) {
    throw new Error('Invalid control reply proof');
  }
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: controllerKey } });
  if (!crypto.verify(null, data, key, Buffer.from(reply.signature, 'base64url'))) {
    throw new Error('Invalid control reply signature');
  }
  return reply;
}

// Keep the historical identity for cached signed settings. After restore an
// independently generated live authority fences old copies of that identity.
function signAuthorityReply(reply, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid control authority');
  const authorityKey = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  const body = Buffer.from(JSON.stringify(['awg-easy-3/control-authority/v1', authorityKey, reply]));
  return { reply, authorityKey, authoritySignature: crypto.sign(null, body, key).toString('base64url') };
}
function verifyAuthorityReply(value, authorityKey) {
  if (!authorityKey) return value; // Legacy mode still undergoes exact reply validation.
  try {
    if (!value || Object.keys(value).sort().join(',') !== 'authorityKey,authoritySignature,reply'
      || value.authorityKey !== authorityKey || !/^[A-Za-z0-9_-]{86}$/.test(value.authoritySignature)
      || Buffer.from(value.authoritySignature, 'base64url').toString('base64url') !== value.authoritySignature) throw new Error();
    const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: authorityKey } });
    const body = Buffer.from(JSON.stringify(['awg-easy-3/control-authority/v1', authorityKey, value.reply]));
    if (!crypto.verify(null, body, key, Buffer.from(value.authoritySignature, 'base64url'))) throw new Error();
    return value.reply;
  } catch { throw new Error('Invalid live control authority'); }
}
module.exports = { signControl, verifyControl, signControlReply, verifyControlReply,
  signAuthorityReply, verifyAuthorityReply };
