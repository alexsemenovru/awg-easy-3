'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');

const MAX_REPLY = 8192;

async function listenInvitationSocket(socketPath, issue) {
  if (typeof issue !== 'function') throw new TypeError('Invitation issuer required');
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
    if (request.method !== 'POST' || request.url !== '/issue') {
      response.writeHead(404).end(); return;
    }
    try {
      const code = await issue();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ code }));
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

async function requestInvitation(socketPath) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/')) throw new TypeError('Absolute control socket required');
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/issue', method: 'POST', timeout: 5000 }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_REPLY) { request.destroy(new Error('Control response too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error('Cell invitation unavailable')); return; }
        try {
          const { code } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof code !== 'string' || code.length < 32 || code.length > 4096) throw new Error();
          resolve(code);
        } catch { reject(new Error('Invalid Cell invitation response')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Control socket timed out')));
    request.on('error', reject);
    request.end();
  });
}

module.exports = { listenInvitationSocket, requestInvitation };
