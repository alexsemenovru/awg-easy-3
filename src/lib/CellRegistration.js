'use strict';

const crypto = require('node:crypto');

const MAX_AGE_MS = 5 * 60 * 1000;
const fail = () => { throw new Error('Invalid cell registration proof'); };
const encoded = (value, length) => typeof value === 'string'
  && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').length === length
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const identifier = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

function identity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ format: 'jwk' }).x };
}

function message(request) {
  if (!request || request.version !== 1 || !identifier(request.invitationId)
    || !identifier(request.requestId) || !encoded(request.cellKey, 32)
    || !encoded(request.controllerKey, 32) || !encoded(request.secret, 32)
    || !Number.isSafeInteger(request.issuedAt) || request.issuedAt < 0) fail();
  // Fixed-order, domain-separated representation; never sign arbitrary JSON.
  return Buffer.from(JSON.stringify(['awg-easy-3/cell-registration/v1', request.invitationId,
    request.requestId, request.controllerKey, request.cellKey, request.issuedAt,
    crypto.createHash('sha256').update(request.secret).digest('hex')]));
}

function signRegistration(invitation, privateKey, now = Date.now()) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') fail();
  const request = { version: 1, invitationId: invitation.id,
    requestId: crypto.randomBytes(16).toString('hex'), controllerKey: invitation.controllerKey,
    cellKey: crypto.createPublicKey(key).export({ format: 'jwk' }).x,
    secret: invitation.secret, issuedAt: now };
  return { ...request, signature: crypto.sign(null, message(request), key).toString('base64url') };
}

function verifyRegistration(request, controllerKey, now = Date.now()) {
  const bytes = message(request);
  if (!encoded(request.signature, 64) || request.controllerKey !== controllerKey
    || !Number.isSafeInteger(now) || now < request.issuedAt
    || now - request.issuedAt >= MAX_AGE_MS) fail();
  const key = crypto.createPublicKey({ format: 'jwk', key: {
    kty: 'OKP', crv: 'Ed25519', x: request.cellKey,
  } });
  if (!crypto.verify(null, bytes, key, Buffer.from(request.signature, 'base64url'))) fail();
  return { secret: request.secret, requestId: request.requestId,
    cellKey: request.cellKey, registrationValid: true };
}

function receiptMessage(receipt) {
  if (!receipt || receipt.version !== 1 || receipt.status !== 'registered'
    || !identifier(receipt.invitationId) || !identifier(receipt.requestId)
    || !encoded(receipt.controllerKey, 32) || !encoded(receipt.cellKey, 32)
    || !encoded(receipt.requestHash, 32) || !Number.isSafeInteger(receipt.issuedAt)
    || receipt.issuedAt < 0) fail();
  return Buffer.from(JSON.stringify(['awg-easy-3/cell-registration-receipt/v1',
    receipt.invitationId, receipt.requestId, receipt.controllerKey, receipt.cellKey,
    receipt.requestHash, receipt.status, receipt.issuedAt]));
}

const requestHash = request => crypto.createHash('sha256').update(message(request)).digest('base64url');

// Only call after the registration has been durably committed.
function signReceipt(request, privateKey, now = Date.now()) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') fail();
  const controllerKey = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  verifyRegistration(request, controllerKey, now);
  const receipt = { version: 1, status: 'registered', invitationId: request.invitationId,
    requestId: request.requestId, cellKey: request.cellKey, controllerKey,
    requestHash: requestHash(request), issuedAt: now };
  return { ...receipt, signature: crypto.sign(null, receiptMessage(receipt), key).toString('base64url') };
}

function verifyReceipt(receipt, request, controllerKey, now = Date.now()) {
  verifyRegistration(request, controllerKey, now);
  const bytes = receiptMessage(receipt);
  if (receipt.controllerKey !== controllerKey || receipt.invitationId !== request.invitationId
    || receipt.requestId !== request.requestId || receipt.cellKey !== request.cellKey
    || receipt.requestHash !== requestHash(request) || receipt.issuedAt < request.issuedAt
    || receipt.issuedAt > now || !encoded(receipt.signature, 64)) fail();
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: controllerKey } });
  if (!crypto.verify(null, bytes, key, Buffer.from(receipt.signature, 'base64url'))) fail();
  return { controllerKey, cellKey: receipt.cellKey, invitationId: receipt.invitationId, status: 'registered' };
}

module.exports = { identity, signRegistration, verifyRegistration, signReceipt, verifyReceipt };
