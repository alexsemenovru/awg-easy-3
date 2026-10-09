'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { TextDecoder } = require('node:util');
const { AwgKeyManager, validateKey } = require('./AwgKeyManager');
const { validateProfile } = require('./Awg3Config');
const { privateAddress } = require('./CellTunnelControlTransport');
const { validatePermanentDescriptor } = require('./CellAwgPermanentDescriptor');
const { validEndpointHost } = require('./CellAwgEndpointHost');

const MAX_CODE_LENGTH = 8192;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[a-f0-9]{32}$/;
const invalid = () => { throw new Error('Invalid or unavailable AWG cell invitation'); };

function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some(field => !Object.hasOwn(value, field))) invalid();
}

function token(value) {
  return typeof value === 'string' && TOKEN.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function port(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

function validatePayload(value) {
  exact(value, ['version', 'kind', 'id', 'controllerKey', 'secret', 'expiresAt',
    'endpointHost', 'endpointPort', 'registrationPort', 'controllerAddress',
    'cellAddress', 'serverPublicKey', 'temporaryPrivateKey', 'temporaryPresharedKey', 'profile']);
  if (value.version !== 2 || value.kind !== 'cell-awg-invitation'
    || typeof value.id !== 'string' || !ID.test(value.id)
    || !token(value.controllerKey) || !token(value.secret)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
    || !validEndpointHost(value.endpointHost) || !port(value.endpointPort) || !port(value.registrationPort)
    || !privateAddress(value.controllerAddress) || !privateAddress(value.cellAddress)
    || value.controllerAddress.startsWith('127.') || value.cellAddress.startsWith('127.')
    || value.controllerAddress === '::1' || value.cellAddress === '::1'
    || net.isIP(value.controllerAddress) !== net.isIP(value.cellAddress)
    || value.controllerAddress === value.cellAddress) invalid();
  try {
    validateKey(value.serverPublicKey, 'serverPublicKey');
    validateKey(value.temporaryPrivateKey, 'temporaryPrivateKey');
    validateKey(value.temporaryPresharedKey, 'temporaryPresharedKey');
    const profile = validateProfile(value.profile);
    if (Object.keys(value.profile).sort().join(',') !== Object.keys(profile).sort().join(',')) invalid();
    return { version: 2, kind: 'cell-awg-invitation', id: value.id,
      controllerKey: value.controllerKey, secret: value.secret, expiresAt: value.expiresAt,
      endpointHost: value.endpointHost, endpointPort: value.endpointPort,
      registrationPort: value.registrationPort, controllerAddress: value.controllerAddress,
      cellAddress: value.cellAddress, serverPublicKey: value.serverPublicKey,
      temporaryPrivateKey: value.temporaryPrivateKey,
      temporaryPresharedKey: value.temporaryPresharedKey, profile };
  } catch { invalid(); }
}

// Caller must durably reserve the address and install a guarded temporary peer
// before displaying the code. The temporary private key appears only in the code,
// never in the returned server-side record.
async function createAwgBootstrapInvitation({ controllerKey, endpointHost, endpointPort,
  registrationPort, controllerAddress, cellAddress, serverPublicKey,
  permanentDescriptor, keyManager = new AwgKeyManager(),
  profile, now = Date.now(), lifetimeMs = 900000 }) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(lifetimeMs)
    || lifetimeMs < 1 || lifetimeMs > MAX_LIFETIME_MS || now + lifetimeMs > Number.MAX_SAFE_INTEGER
    || !keyManager || typeof keyManager.generatePeerKeys !== 'function') invalid();
  const temporaryKeys = await keyManager.generatePeerKeys();
  if (!temporaryKeys || typeof temporaryKeys !== 'object' || Array.isArray(temporaryKeys)
    || Object.keys(temporaryKeys).sort().join(',') !== 'presharedKey,privateKey,publicKey') invalid();
  const payload = validatePayload({ version: 2, kind: 'cell-awg-invitation',
    id: crypto.randomBytes(16).toString('hex'), controllerKey,
    secret: crypto.randomBytes(32).toString('base64url'), expiresAt: now + lifetimeMs,
    endpointHost, endpointPort, registrationPort, controllerAddress, cellAddress,
    serverPublicKey, temporaryPrivateKey: temporaryKeys?.privateKey,
    temporaryPresharedKey: temporaryKeys?.presharedKey, profile });
  validateKey(temporaryKeys.publicKey, 'temporaryPublicKey');
  const code = Buffer.from(JSON.stringify(payload)).toString('base64url');
  if (code.length > MAX_CODE_LENGTH) invalid();
  return { code, record: {
    version: 2, id: payload.id, status: 'pending', createdAt: now,
    expiresAt: payload.expiresAt,
    secretHash: crypto.createHash('sha256').update(payload.secret).digest('hex'),
    temporaryPublicKey: temporaryKeys.publicKey,
    temporaryPresharedKey: temporaryKeys.presharedKey,
    cellAddress: payload.cellAddress,
    ...(permanentDescriptor ? { permanentDescriptor: validatePermanentDescriptor(permanentDescriptor) } : {}),
  } };
}

function decodeAwgBootstrapInvitation(code, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 || typeof code !== 'string'
    || code.length > MAX_CODE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(code)) invalid();
  const bytes = Buffer.from(code, 'base64url');
  if (bytes.toString('base64url') !== code) invalid();
  let payload;
  try { payload = validatePayload(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes))); }
  catch { invalid(); }
  if (payload.expiresAt <= now) invalid();
  return payload;
}

module.exports = { createAwgBootstrapInvitation, decodeAwgBootstrapInvitation };
