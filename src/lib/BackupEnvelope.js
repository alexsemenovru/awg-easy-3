'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_PLAINTEXT = 8 * 1024 * 1024;
const MAX_ARCHIVE = 12 * 1024 * 1024;
const PREFIX = 'AWG3-B1-';
const INFO = Buffer.from('awg-easy-3/backup-envelope/v1');
const fail = () => { throw new Error('Invalid backup archive or recovery key'); };
const decode = (value, size) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) fail();
  return bytes;
};
const keyFor = (secret, id) => Buffer.from(crypto.hkdfSync('sha256', secret, id, INFO, 32));
const aadFor = id => Buffer.concat([INFO, Buffer.from([0]), id]);

// This is only the authenticated archive envelope. The caller must supply a
// validated, consistent snapshot and arrange Cell generation/fencing during
// restore; the encrypted bytes alone never authorize takeover.
function sealBackup(plaintext) {
  if (!Buffer.isBuffer(plaintext) || !plaintext.length
    || plaintext.length > MAX_PLAINTEXT) throw new TypeError('Backup snapshot size is invalid');
  const secret = crypto.randomBytes(32);
  const id = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secret, id), nonce);
  cipher.setAAD(aadFor(id));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const archive = Buffer.from(JSON.stringify({ version: 1,
    id: id.toString('base64url'), nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url') }));
  if (archive.length > MAX_ARCHIVE) throw new Error('Backup archive too large');
  return Object.freeze({ archive, recoveryKey: `${PREFIX}${secret.toString('base64url')}`,
    id: id.toString('base64url') });
}

function openBackup(archive, recoveryKey) {
  try {
    if (!Buffer.isBuffer(archive) || !archive.length || archive.length > MAX_ARCHIVE
      || typeof recoveryKey !== 'string' || !recoveryKey.startsWith(PREFIX)) fail();
    const secret = decode(recoveryKey.slice(PREFIX.length), 32);
    const data = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(archive));
    if (!Buffer.from(JSON.stringify(data)).equals(archive)) fail();
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1
      || Object.keys(data).sort().join(',') !== 'ciphertext,id,nonce,tag,version') fail();
    const id = decode(data.id, 16), nonce = decode(data.nonce, 12), tag = decode(data.tag, 16);
    if (typeof data.ciphertext !== 'string' || data.ciphertext.length > 4 * MAX_PLAINTEXT / 3 + 4) fail();
    const ciphertext = decode(data.ciphertext, Buffer.from(data.ciphertext, 'base64url').length);
    if (!ciphertext.length || ciphertext.length > MAX_PLAINTEXT) fail();
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secret, id), nonce);
    decipher.setAAD(aadFor(id));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { fail(); }
}

module.exports = { sealBackup, openBackup };
