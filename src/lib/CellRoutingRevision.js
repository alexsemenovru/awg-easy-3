'use strict';

const crypto = require('node:crypto');
const { validateRoutingView } = require('./CellRoutingView');

const MAX_BYTES = 256 * 1024;
const token = (value, size) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
  && Buffer.from(value, 'base64url').length === size
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const fail = () => { throw new Error('Invalid Cell routing revision'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function signedBytes(value) {
  if (!exact(value, ['version', 'controllerKey', 'cellKey', 'revision', 'payload', 'signature'])
    || value.version !== 1 || !token(value.controllerKey, 32)
    || !token(value.cellKey, 32) || !token(value.signature, 64)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.payload !== 'string' || Buffer.byteLength(value.payload) > MAX_BYTES) fail();
  return Buffer.from(JSON.stringify(['awg-easy-3/cell-routing/v1', value.controllerKey,
    value.cellKey, value.revision, value.payload]));
}

function signRoutingRevision({ cellKey, revision, view }, privateKey) {
  if (!token(cellKey, 32) || !Number.isSafeInteger(revision) || revision < 1) fail();
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') fail();
  const payload = JSON.stringify(validateRoutingView(view));
  if (Buffer.byteLength(payload) > MAX_BYTES) fail();
  const unsigned = { version: 1,
    controllerKey: crypto.createPublicKey(key).export({ format: 'jwk' }).x,
    cellKey, revision, payload, signature: '' };
  // Signature is part of the strict envelope shape, but not the signed bytes.
  unsigned.signature = Buffer.alloc(64).toString('base64url');
  return Object.freeze({ ...unsigned,
    signature: crypto.sign(null, signedBytes(unsigned), key).toString('base64url') });
}

function verifyRoutingRevision(envelope, { controllerKey, cellKey,
  nodeId, minimumRevision = 1 } = {}) {
  const bytes = signedBytes(envelope);
  if (!token(controllerKey, 32) || !token(cellKey, 32)
    || envelope.controllerKey !== controllerKey || envelope.cellKey !== cellKey
    || !Number.isSafeInteger(minimumRevision) || minimumRevision < 1
    || envelope.revision < minimumRevision) fail();
  const key = crypto.createPublicKey({ format: 'jwk',
    key: { kty: 'OKP', crv: 'Ed25519', x: controllerKey } });
  if (!crypto.verify(null, bytes, key, Buffer.from(envelope.signature, 'base64url'))) fail();
  let view;
  try { view = JSON.parse(envelope.payload); } catch { fail(); }
  return Object.freeze({ revision: envelope.revision,
    view: validateRoutingView(view, nodeId),
    hash: crypto.createHash('sha256').update(bytes).digest('hex') });
}

module.exports = { signRoutingRevision, verifyRoutingRevision };
