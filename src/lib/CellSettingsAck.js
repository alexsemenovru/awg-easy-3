'use strict';
const crypto = require('node:crypto');
const { verifySettings } = require('./CellSettings');

function body(value) {
  if (!value || value.version !== 1 || value.status !== 'applied'
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !/^[a-f0-9]{64}$/.test(value.hash)
    || ![value.controllerKey, value.cellKey].every(key => typeof key === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(key) && Buffer.from(key, 'base64url').toString('base64url') === key)) {
    throw new Error('Invalid settings acknowledgement');
  }
  return Buffer.from(JSON.stringify(['awg-easy-3/settings-applied/v1', value.controllerKey,
    value.cellKey, value.revision, value.hash, value.status]));
}

function signSettingsAck(envelope, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid cell identity');
  const cellKey = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  const { hash } = verifySettings(envelope, { controllerKey: envelope.controllerKey, cellKey });
  const ack = { version: 1, status: 'applied', controllerKey: envelope.controllerKey, cellKey,
    revision: envelope.revision, hash };
  return { ...ack, signature: crypto.sign(null, body(ack), key).toString('base64url') };
}

function verifySettingsAck(ack, envelope) {
  const { hash } = verifySettings(envelope, envelope);
  const data = body(ack);
  if (ack.controllerKey !== envelope.controllerKey || ack.cellKey !== envelope.cellKey
    || ack.revision !== envelope.revision || ack.hash !== hash
    || typeof ack.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(ack.signature)
    || Buffer.from(ack.signature, 'base64url').toString('base64url') !== ack.signature) {
    throw new Error('Settings acknowledgement mismatch');
  }
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: envelope.cellKey } });
  if (!crypto.verify(null, data, key, Buffer.from(ack.signature, 'base64url'))) throw new Error('Invalid acknowledgement signature');
  return { revision: ack.revision, status: 'applied' };
}

// Caller must load the persisted applied state, not simply a received envelope.
async function acknowledgeApplied(receiver, identityStore) {
  const state = await receiver.load();
  if (!state?.applied) throw new Error('No applied settings to acknowledge');
  const identity = await identityStore.load('cell');
  return signSettingsAck(state.applied, identity.privateKey);
}

module.exports = { signSettingsAck, verifySettingsAck, acknowledgeApplied };
