'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const queues = new Map();
const RENEW_BEFORE_MS = 30 * 86400000;

function inspect(pem, publicKey) {
  try {
    const cert = new crypto.X509Certificate(pem);
    if (cert.publicKey.asymmetricKeyType !== 'ed25519'
      || cert.publicKey.export({ format: 'jwk' }).x !== publicKey
      || cert.subject !== cert.issuer || !cert.verify(cert.publicKey)) throw new Error('mismatch');
    const expiresAt = Date.parse(cert.validTo);
    const startsAt = Date.parse(cert.validFrom);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(startsAt)) throw new Error('dates');
    return { expiresAt, startsAt };
  } catch { throw new Error('Invalid control certificate or identity mismatch'); }
}

class ControlCertificateStore {
  constructor(filePath, identityStore, { openssl = 'openssl', execute = run } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('Certificate path required');
    this.filePath = path.resolve(filePath);
    this.identityStore = identityStore;
    this.openssl = openssl;
    this.execute = execute;
  }

  ensure() {
    const previous = queues.get(this.filePath) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.prepare());
    queues.set(this.filePath, task);
    const cleanup = () => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); };
    task.then(cleanup, cleanup);
    return task;
  }

  async prepare() {
    const identity = await this.identityStore.load('controller');
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid control certificate file');
      const pem = await fs.readFile(this.filePath, 'utf8');
      const dates = inspect(pem, identity.publicKey);
      if (dates.startsAt > Date.now()) throw new Error('Control certificate is not yet valid; check system clock');
      if (dates.expiresAt > Date.now() + RENEW_BEFORE_MS) return pem;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await fs.mkdtemp(path.join(directory, '.control-cert-'));
    const keyPath = path.join(temporary, 'key.pem');
    const certPath = path.join(temporary, 'cert.pem');
    try {
      await fs.chmod(temporary, 0o700);
      await fs.writeFile(keyPath, identity.privateKey, { flag: 'wx', mode: 0o600 });
      // No shell, network, public CA, DNS name or private key in process arguments.
      try {
        await this.execute(this.openssl, ['req', '-new', '-x509', '-key', keyPath,
          '-out', certPath, '-days', '365', '-subj', '/CN=AWG-Easy-3-Control'],
        { timeout: 15000, maxBuffer: 65536, windowsHide: true });
      } catch { throw new Error('Unable to generate control certificate; check local OpenSSL availability'); }
      const pem = await fs.readFile(certPath, 'utf8');
      const dates = inspect(pem, identity.publicKey);
      if (dates.expiresAt <= Date.now() + RENEW_BEFORE_MS || dates.startsAt > Date.now()) {
        throw new Error('Generated control certificate validity is invalid');
      }
      await fs.chmod(certPath, 0o600);
      const handle = await fs.open(certPath, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      await fs.rename(certPath, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      return pem;
    } finally {
      // Only exact files created in this private temporary directory are removed.
      await fs.unlink(keyPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.unlink(certPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(temporary);
    }
  }
}

module.exports = { ControlCertificateStore };
