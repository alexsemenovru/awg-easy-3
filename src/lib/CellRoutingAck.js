'use strict';

const crypto = require('node:crypto');
const { verifyRoutingRevision } = require('./CellRoutingRevision');

const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');

function body(value) {
  if (!exact(value, ['version', 'status', 'controllerKey', 'cellKey', 'revision', 'hash', 'signature'])
    || value.version !== 1 || value.status !== 'applied'
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !/^[a-f0-9]{64}$/.test(value.hash)
    || ![value.controllerKey, value.cellKey].every(key => typeof key === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(key)
      && Buffer.from(key, 'base64url').toString('base64url') === key)
    || typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)
    || Buffer.from(value.signature, 'base64url').toString('base64url') !== value.signature) {
    throw new Error('Invalid routing acknowledgement');
  }
  return Buffer.from(JSON.stringify(['awg-easy-3/routing-applied/v1', value.controllerKey,
    value.cellKey, value.revision, value.hash, value.status]));
}

function signRoutingAck(envelope, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid Cell identity');
  const cellKey = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  const { hash } = verifyRoutingRevision(envelope, { controllerKey: envelope.controllerKey,
    cellKey });
  const unsigned = { version: 1, status: 'applied', controllerKey: envelope.controllerKey,
    cellKey, revision: envelope.revision, hash,
    signature: Buffer.alloc(64).toString('base64url') };
  return Object.freeze({ ...unsigned,
    signature: crypto.sign(null, body(unsigned), key).toString('base64url') });
}

function verifyRoutingAck(ack, envelope) {
  const { hash } = verifyRoutingRevision(envelope, { controllerKey: envelope.controllerKey,
    cellKey: envelope.cellKey });
  const bytes = body(ack);
  if (ack.controllerKey !== envelope.controllerKey || ack.cellKey !== envelope.cellKey
    || ack.revision !== envelope.revision || ack.hash !== hash) {
    throw new Error('Routing acknowledgement mismatch');
  }
  const key = crypto.createPublicKey({ format: 'jwk',
    key: { kty: 'OKP', crv: 'Ed25519', x: envelope.cellKey } });
  if (!crypto.verify(null, bytes, key, Buffer.from(ack.signature, 'base64url'))) {
    throw new Error('Invalid routing acknowledgement signature');
  }
  return Object.freeze({ revision: ack.revision, hash });
}

module.exports = { signRoutingAck, verifyRoutingAck };
