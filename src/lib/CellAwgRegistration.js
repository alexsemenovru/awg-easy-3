'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { MAX_CLOCK_SKEW_MS } = require('./CellClock');
const { validateKey } = require('./AwgKeyManager');
const { validatePermanentDescriptor } = require('./CellAwgPermanentDescriptor');

const MAX_AGE_MS = 5 * 60 * 1000;
const invalid = () => { throw new Error('Invalid AWG cell registration proof'); };
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const token = (value, size) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
  && Buffer.from(value, 'base64url').length === size
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const unsigned = ['version', 'invitationId', 'requestId', 'controllerKey', 'cellKey',
  'secret', 'awgPublicKey', 'awgPresharedKey', 'issuedAt'];
const fields = [...unsigned, 'signature'];
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');

function requestMessage(request) {
  if (!exact(request, unsigned) || request.version !== 2 || !id(request.invitationId)
    || !id(request.requestId) || !token(request.controllerKey, 32)
    || !token(request.cellKey, 32) || !token(request.secret, 32)
    || !Number.isSafeInteger(request.issuedAt) || request.issuedAt < 0) invalid();
  try { validateKey(request.awgPublicKey, 'awgPublicKey');
    validateKey(request.awgPresharedKey, 'awgPresharedKey'); }
  catch { invalid(); }
  return Buffer.from(JSON.stringify(['awg-easy-3/cell-awg-registration/v2',
    request.invitationId, request.requestId, request.controllerKey, request.cellKey,
    request.awgPublicKey, request.awgPresharedKey, request.issuedAt,
    crypto.createHash('sha256').update(request.secret).digest('hex')]));
}

function signAwgRegistration(invitation, identityPrivateKey, { publicKey, presharedKey }, now = Date.now()) {
  let key;
  try { key = crypto.createPrivateKey(identityPrivateKey); }
  catch { invalid(); }
  if (key.asymmetricKeyType !== 'ed25519') invalid();
  const request = { version: 2, invitationId: invitation.id,
    requestId: crypto.randomBytes(16).toString('hex'), controllerKey: invitation.controllerKey,
    cellKey: crypto.createPublicKey(key).export({ format: 'jwk' }).x,
    secret: invitation.secret, awgPublicKey: publicKey,
    awgPresharedKey: presharedKey, issuedAt: now };
  return { ...request, signature: crypto.sign(null, requestMessage(request), key).toString('base64url') };
}

function verifyAwgRegistration(request, controllerKey, now = Date.now()) {
  if (!exact(request, fields) || !token(request.signature, 64)) invalid();
  const body = Object.fromEntries(unsigned.map(name => [name, request[name]]));
  const bytes = requestMessage(body);
  if (request.controllerKey !== controllerKey || !Number.isSafeInteger(now)
    || request.issuedAt - now > MAX_CLOCK_SKEW_MS
    || now - request.issuedAt >= MAX_AGE_MS) invalid();
  let key;
  try { key = crypto.createPublicKey({ format: 'jwk', key: {
    kty: 'OKP', crv: 'Ed25519', x: request.cellKey,
  } }); } catch { invalid(); }
  if (!crypto.verify(null, bytes, key, Buffer.from(request.signature, 'base64url'))) invalid();
  return { secret: request.secret, requestId: request.requestId, cellKey: request.cellKey,
    awgPublicKey: request.awgPublicKey, awgPresharedKey: request.awgPresharedKey,
    registrationValid: true };
}

function parseAwgRegistration(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 2048) invalid();
  let request;
  try { request = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
  catch { invalid(); }
  if (!exact(request, fields) || !token(request.signature, 64)) invalid();
  requestMessage(Object.fromEntries(unsigned.map(name => [name, request[name]])));
  return request;
}

const requestHash = request => crypto.createHash('sha256').update(requestMessage(
  Object.fromEntries(unsigned.map(name => [name, request[name]])))).digest('base64url');

function receiptMessage(receipt) {
  const basic = ['version', 'status', 'invitationId', 'requestId', 'cellKey',
    'controllerKey', 'requestHash', 'issuedAt'];
  const permanent = receipt.version === 3
    ? validatePermanentDescriptor(receipt.permanent) : null;
  if (!exact(receipt, permanent ? [...basic, 'permanent'] : basic)
    || ![2, 3].includes(receipt.version) || receipt.status !== 'registered'
    || !id(receipt.invitationId) || !id(receipt.requestId)
    || !token(receipt.cellKey, 32) || !token(receipt.controllerKey, 32)
    || !token(receipt.requestHash, 32)
    || !Number.isSafeInteger(receipt.issuedAt) || receipt.issuedAt < 0) invalid();
  return Buffer.from(JSON.stringify([`awg-easy-3/cell-awg-registration-receipt/v${receipt.version}`,
    receipt.invitationId, receipt.requestId, receipt.controllerKey, receipt.cellKey,
    receipt.requestHash, receipt.status, receipt.issuedAt,
    ...(permanent ? [permanent] : [])]));
}

function signAwgReceipt(request, identityPrivateKey, now = Date.now(), permanentDescriptor) {
  let key;
  try { key = crypto.createPrivateKey(identityPrivateKey); }
  catch { invalid(); }
  if (key.asymmetricKeyType !== 'ed25519') invalid();
  const controllerKey = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  verifyAwgRegistration(request, controllerKey, now);
  const receipt = { version: permanentDescriptor ? 3 : 2, status: 'registered', invitationId: request.invitationId,
    requestId: request.requestId, cellKey: request.cellKey, controllerKey,
    requestHash: requestHash(request), issuedAt: now };
  if (permanentDescriptor) receipt.permanent = validatePermanentDescriptor(permanentDescriptor);
  return { ...receipt, signature: crypto.sign(null, receiptMessage(receipt), key).toString('base64url') };
}

function verifyAwgReceipt(receipt, request, controllerKey, now = Date.now()) {
  verifyAwgRegistration(request, controllerKey, now);
  if (!receipt || ![2, 3].includes(receipt.version)
    || !exact(receipt, ['version', 'status', 'invitationId', 'requestId', 'cellKey',
      'controllerKey', 'requestHash', 'issuedAt', 'signature',
      ...(receipt.version === 3 ? ['permanent'] : [])])
    || !token(receipt.signature, 64)) invalid();
  const body = { ...receipt }; delete body.signature;
  const bytes = receiptMessage(body);
  if (receipt.controllerKey !== controllerKey || receipt.invitationId !== request.invitationId
    || receipt.requestId !== request.requestId || receipt.cellKey !== request.cellKey
    || receipt.requestHash !== requestHash(request)
    || request.issuedAt - receipt.issuedAt > MAX_CLOCK_SKEW_MS
    || receipt.issuedAt - now > MAX_CLOCK_SKEW_MS) invalid();
  let key;
  try { key = crypto.createPublicKey({ format: 'jwk', key: {
    kty: 'OKP', crv: 'Ed25519', x: controllerKey,
  } }); } catch { invalid(); }
  if (!crypto.verify(null, bytes, key, Buffer.from(receipt.signature, 'base64url'))) invalid();
  return { controllerKey, cellKey: receipt.cellKey,
    invitationId: receipt.invitationId, status: 'registered',
    ...(receipt.version === 3 ? { permanent: validatePermanentDescriptor(receipt.permanent) } : {}) };
}

module.exports = { signAwgRegistration, verifyAwgRegistration, parseAwgRegistration,
  signAwgReceipt, verifyAwgReceipt };
