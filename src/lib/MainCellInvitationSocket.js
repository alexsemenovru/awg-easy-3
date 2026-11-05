'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const MAX_REPLY = 9000;
const MAX_BACKUP_REPLY = 17 * 1024 * 1024;

async function listenInvitationSocket(socketPath, issue, { createBackup = null } = {}) {
  if (typeof issue !== 'function') throw new TypeError('Invitation issuer required');
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
    throw new TypeError('Absolute control socket required');
  }
  const parent = await fs.lstat(path.dirname(socketPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || (process.platform !== 'win32'
      && (parent.uid !== process.getuid() || (parent.mode & 0o077)))) {
    throw new Error('Private control socket directory required');
  }
  try {
    const entry = await fs.lstat(socketPath);
    if (!entry.isSocket()) throw new Error('Control path is not a socket');
    await new Promise((resolve, reject) => {
      const probe = http.request({ socketPath, path: '/health', timeout: 1500 }, response => {
        response.resume(); resolve();
      });
      probe.on('timeout', () => probe.destroy(new Error('Control socket probe timed out')));
      probe.on('error', reject);
      probe.end();
    }).then(() => { throw new Error('Control socket is already in use'); }, async error => {
      if (error.code !== 'ECONNREFUSED') throw error;
      await fs.unlink(socketPath);
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const backup = request.url === '/backup' && typeof createBackup === 'function';
    if (request.method !== 'POST' || request.url !== '/issue' && !backup) {
      response.writeHead(404).end(); return;
    }
    try {
      const result = backup ? await createBackup() : { code: await issue() };
      response.setHeader('Content-Type', 'application/json');
      const bytes = JSON.stringify(result);
      if (Buffer.byteLength(bytes) > (backup ? MAX_BACKUP_REPLY : MAX_REPLY)) throw new Error('Control reply too large');
      response.end(bytes);
    } catch {
      response.writeHead(503).end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    await fs.chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return { close: async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } };
}

async function requestControl(socketPath, route, limit, timeout) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/')) throw new TypeError('Absolute control socket required');
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method: 'POST', timeout }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { request.destroy(new Error('Control response too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error('Main control operation unavailable')); return; }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch { reject(new Error('Invalid Main control response')); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Control socket timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function requestInvitation(socketPath) {
  const { code } = await requestControl(socketPath, '/issue', MAX_REPLY, 5000);
  if (typeof code !== 'string' || code.length < 32 || code.length > 8192) throw new Error('Invalid Cell invitation response');
  return code;
}
async function requestBackup(socketPath) {
  const value = await requestControl(socketPath, '/backup', MAX_BACKUP_REPLY, 60000);
  if (!value || Object.keys(value).sort().join(',') !== 'archive,createdAt,generation,id,recoveryKey'
    || !/^[A-Za-z0-9_-]{22}$/.test(value.id) || !/^AWG3-B1-[A-Za-z0-9_-]{43}$/.test(value.recoveryKey)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || typeof value.archive !== 'string' || !value.archive.length || value.archive.length > 16 * 1024 * 1024
    || Buffer.from(value.archive, 'base64').toString('base64') !== value.archive) throw new Error('Invalid Main backup response');
  return value;
}
module.exports = { listenInvitationSocket, requestInvitation, requestBackup };
