'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const { ApiError } = require('./ApiService');

const BODY_LIMIT = 16 * 1024;
const COOKIE_NAME = 'awg_easy_3_session';

const securityHeaders = (response, { api = false } = {}) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (api) response.setHeader('Cache-Control', 'no-store');
};

const sendJson = (response, statusCode, value) => {
  const body = `${JSON.stringify(value)}\n`;
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
};

const readJson = async (request) => {
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(415, 'Content-Type must be application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new ApiError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed;
  } catch {
    throw new ApiError(400, 'Request body must be a JSON object');
  }
};

const sessionToken = (request) => {
  const cookie = String(request.headers.cookie ?? '');
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === COOKIE_NAME) return part.slice(separator + 1).trim();
  }
  return undefined;
};

const assertSameSite = (request) => {
  if (String(request.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    throw new ApiError(403, 'Cross-site request rejected');
  }
  const origin = request.headers.origin;
  if (!origin) return;
  const host = request.headers.host;
  if (!host || origin !== `http://${host}` && origin !== `https://${host}`) {
    throw new ApiError(403, 'Request origin rejected');
  }
};

const clientRoute = (pathname) => {
  const match = pathname.match(/^\/api\/v1\/clients\/([^/]+)(?:\/(export))?$/);
  if (!match) return null;
  try {
    return { id: decodeURIComponent(match[1]), export: match[2] === 'export' };
  } catch {
    throw new ApiError(400, 'Invalid client identifier');
  }
};

class HttpServer {
  constructor({ api, publicDirectory = path.join(__dirname, '..', 'www'), fileSystem = fs } = {}) {
    if (!api) throw new TypeError('api is required');
    this.api = api;
    this.publicDirectory = path.resolve(publicDirectory);
    this.fs = fileSystem;
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  async apiRequest(request, response, url) {
    securityHeaders(response, { api: true });
    const token = sessionToken(request);
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (mutation) assertSameSite(request);

    if (url.pathname === '/api/v1/session') {
      if (request.method === 'GET') return sendJson(response, 200, await this.api.session(token));
      if (request.method === 'POST') {
        const body = await readJson(request);
        const result = await this.api.login(body.password);
        response.setHeader('Set-Cookie', result.cookie);
        return sendJson(response, 200, { authenticated: true });
      }
      if (request.method === 'DELETE') {
        const result = this.api.logout();
        response.setHeader('Set-Cookie', result.cookie);
        return sendJson(response, 200, { success: true });
      }
    }

    if (url.pathname === '/api/v1/clients') {
      if (request.method === 'GET') return sendJson(response, 200, await this.api.listClients(token));
      if (request.method === 'POST') {
        return sendJson(response, 201, await this.api.createClient(token, await readJson(request)));
      }
    }

    const client = clientRoute(url.pathname);
    if (client && !client.export && request.method === 'PATCH') {
      return sendJson(response, 200, await this.api.updateClient(token, client.id, await readJson(request)));
    }
    if (client && !client.export && request.method === 'DELETE') {
      return sendJson(response, 200, await this.api.deleteClient(token, client.id));
    }
    if (client && client.export && request.method === 'GET') {
      const exported = await this.api.exportClient(token, client.id, url.searchParams.get('format'));
      response.statusCode = 200;
      response.setHeader('Content-Type', exported.contentType);
      response.setHeader('Content-Disposition', 'attachment');
      return response.end(exported.value);
    }

    if (url.pathname === '/api/v1/password' && request.method === 'PUT') {
      const body = await readJson(request);
      const result = await this.api.changePassword(token, body.currentPassword, body.newPassword);
      response.setHeader('Set-Cookie', result.cookie);
      return sendJson(response, 200, { success: true });
    }
    throw new ApiError(404, 'Not found');
  }

  async staticRequest(request, response, url) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'Method not allowed');
    securityHeaders(response);
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const filePath = path.resolve(this.publicDirectory, relative);
    if (filePath !== this.publicDirectory && !filePath.startsWith(`${this.publicDirectory}${path.sep}`)) {
      throw new ApiError(404, 'Not found');
    }
    const extensionTypes = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };
    let body;
    try {
      body = await this.fs.readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') throw new ApiError(404, 'Not found');
      throw error;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', extensionTypes[path.extname(filePath)] ?? 'application/octet-stream');
    response.setHeader('Content-Length', body.length);
    response.setHeader('Cache-Control', path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600');
    return response.end(request.method === 'HEAD' ? undefined : body);
  }

  async handle(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await this.apiRequest(request, response, url);
      return await this.staticRequest(request, response, url);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      securityHeaders(response, { api: true });
      const statusCode = error.statusCode
        ?? (error instanceof TypeError || error instanceof RangeError ? 400 : 500);
      return sendJson(response, statusCode, {
        error: statusCode === 500 ? 'Internal server error' : error.message,
      });
    }
  }

  listen({ host, port }) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve(this.server.address());
      });
    });
  }

  close() {
    return new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}

module.exports = {
  BODY_LIMIT,
  HttpServer,
  assertSameSite,
  readJson,
  sessionToken,
};
