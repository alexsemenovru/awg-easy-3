'use strict';

const crypto = require('node:crypto');
const { validEndpointHost } = require('./CellAwgEndpointHost');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === fields.sort().join(',');
const token = (value, length) => typeof value === 'string'
  && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').length === length
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const invalid = () => { throw new Error('Invalid backup recovery proof'); };
const publicKey = key => crypto.createPublicKey({ format: 'jwk',
  key: { kty: 'OKP', crv: 'Ed25519', x: key } });
const signingKey = pem => {
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') invalid();
  return key;
};
const keyId = key => crypto.createPublicKey(key).export({ format: 'jwk' }).x;
function signatureValid(body, signature, key) {
  if (!token(signature, 64) || !crypto.verify(null, body, publicKey(key),
    Buffer.from(signature, 'base64url'))) invalid();
}
function grantBody(grant) {
  if (!exact(grant, ['version', 'controllerKey', 'generation', 'backupId',
    'archiveHash', 'recoveryKey', 'signature']) || grant.version !== 1
    || !token(grant.controllerKey, 32) || !token(grant.recoveryKey, 32)
    || !token(grant.backupId, 16) || !/^[a-f0-9]{64}$/.test(grant.archiveHash)
    || !Number.isSafeInteger(grant.generation) || grant.generation < 1) invalid();
  return Buffer.from(JSON.stringify(['awg-easy-3/backup-grant/v1', grant.controllerKey,
    grant.generation, grant.backupId, grant.archiveHash, grant.recoveryKey]));
}
function createRecoveryMaterial(generation) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return validateRecoveryMaterial({ version: 1, generation,
    backupId: crypto.randomBytes(16).toString('base64url'),
    publicKey: keyId(privateKey), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
}
function validateRecoveryMaterial(value) {
  try {
    if (!exact(value, ['version', 'generation', 'backupId', 'publicKey', 'privateKey'])
      || value.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !token(value.backupId, 16) || !token(value.publicKey, 32)
      || typeof value.privateKey !== 'string' || value.privateKey.length > 1024
      || keyId(signingKey(value.privateKey)) !== value.publicKey) invalid();
    return structuredClone(value);
  } catch { invalid(); }
}
function signBackupGrant(material, archive, controllerPrivateKey) {
  validateRecoveryMaterial(material);
  if (!Buffer.isBuffer(archive) || !archive.length || archive.length > 12 * 1024 * 1024) invalid();
  const key = signingKey(controllerPrivateKey);
  const grant = { version: 1, controllerKey: keyId(key), generation: material.generation,
    backupId: material.backupId, archiveHash: crypto.createHash('sha256').update(archive).digest('hex'),
    recoveryKey: material.publicKey, signature: '' };
  grant.signature = crypto.sign(null, grantBody(grant), key).toString('base64url');
  return grant;
}
function verifyBackupGrant(grant, controllerKey) {
  try {
    const body = grantBody(grant);
    if (grant.controllerKey !== controllerKey) invalid();
    signatureValid(body, grant.signature, controllerKey);
    return structuredClone(grant);
  } catch { invalid(); }
}
function ackBody(ack) {
  if (!exact(ack, ['version', 'controllerKey', 'cellKey', 'generation', 'backupId',
    'archiveHash', 'authorityKey', 'signature']) || ack.version !== 1
    || !token(ack.controllerKey, 32) || !token(ack.cellKey, 32)
    || !Number.isSafeInteger(ack.generation) || ack.generation < 1
    || !token(ack.backupId, 16) || !/^[a-f0-9]{64}$/.test(ack.archiveHash)
    || ack.authorityKey !== null && !token(ack.authorityKey, 32)) invalid();
  return Buffer.from(JSON.stringify(['awg-easy-3/backup-ack/v1', ack.controllerKey,
    ack.cellKey, ack.generation, ack.backupId, ack.archiveHash, ack.authorityKey]));
}
function signBackupAck(grant, cellPrivateKey, authorityKey = null) {
  verifyBackupGrant(grant, grant.controllerKey);
  const key = signingKey(cellPrivateKey);
  const ack = { version: 1, controllerKey: grant.controllerKey, cellKey: keyId(key),
    generation: grant.generation, backupId: grant.backupId, archiveHash: grant.archiveHash, authorityKey, signature: '' };
  ack.signature = crypto.sign(null, ackBody(ack), key).toString('base64url');
  return ack;
}
function verifyBackupAck(ack, grant, cellKey, authorityKey = ack.authorityKey) {
  try {
    verifyBackupGrant(grant, grant.controllerKey);
    const body = ackBody(ack);
    if (ack.controllerKey !== grant.controllerKey || ack.cellKey !== cellKey
      || ack.generation !== grant.generation || ack.backupId !== grant.backupId
      || ack.archiveHash !== grant.archiveHash || ack.authorityKey !== authorityKey) invalid();
    signatureValid(body, ack.signature, cellKey);
    return structuredClone(ack);
  } catch { invalid(); }
}
function takeoverBody(proof) {
  if (!exact(proof, ['version', 'controllerKey', 'cellKey', 'generation', 'backupId',
    'archiveHash', 'challenge', 'authorityKey', 'endpointHost', 'signature']) || proof.version !== 1
    || ![proof.controllerKey, proof.cellKey, proof.authorityKey, proof.challenge].every(value => token(value, 32))
    || !Number.isSafeInteger(proof.generation) || proof.generation < 1
    || !token(proof.backupId, 16) || !/^[a-f0-9]{64}$/.test(proof.archiveHash)
    || proof.authorityKey === proof.controllerKey || proof.authorityKey === proof.cellKey
    || !validEndpointHost(proof.endpointHost)) invalid();
  return Buffer.from(JSON.stringify(['awg-easy-3/backup-takeover/v1', proof.controllerKey,
    proof.cellKey, proof.generation, proof.backupId, proof.archiveHash, proof.challenge,
    proof.authorityKey, proof.endpointHost]));
}
// A backup key does not replace the fresh Cell challenge or its latest grant.
// The authority key is generated on the NEW Main, never archived with old keys.
function signTakeover({ grant, material, cellKey, challenge, authorityKey, endpointHost }) {
  validateRecoveryMaterial(material);
  verifyBackupGrant(grant, grant.controllerKey);
  if (material.backupId !== grant.backupId || material.generation !== grant.generation
    || material.publicKey !== grant.recoveryKey) invalid();
  const proof = { version: 1, controllerKey: grant.controllerKey, cellKey,
    generation: grant.generation, backupId: grant.backupId, archiveHash: grant.archiveHash,
    challenge, authorityKey, endpointHost, signature: '' };
  proof.signature = crypto.sign(null, takeoverBody(proof), signingKey(material.privateKey)).toString('base64url');
  return proof;
}
function verifyTakeover(proof, grant, cellKey, challenge) {
  try {
    verifyBackupGrant(grant, grant.controllerKey);
    const body = takeoverBody(proof);
    if (proof.controllerKey !== grant.controllerKey || proof.cellKey !== cellKey
      || proof.challenge !== challenge || proof.generation !== grant.generation
      || proof.backupId !== grant.backupId || proof.archiveHash !== grant.archiveHash
      || proof.authorityKey === grant.recoveryKey) invalid();
    signatureValid(body, proof.signature, grant.recoveryKey);
    return structuredClone(proof);
  } catch { invalid(); }
}
module.exports = { createRecoveryMaterial, validateRecoveryMaterial, signBackupGrant,
  verifyBackupGrant, signBackupAck, verifyBackupAck, signTakeover, verifyTakeover };
