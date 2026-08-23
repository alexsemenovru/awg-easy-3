'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { HttpServer } = require('../lib/HttpServer');

const request = (port, method, pathname, { body, cookie, headers = {} } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const outgoing = http.request({
    host: '127.0.0.1', port, method, path: pathname,
    headers: {
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({
      body: Buffer.concat(chunks).toString('utf8'),
      headers: response.headers,
      status: response.statusCode,
    }));
  });
  outgoing.on('error', reject);
  if (payload) outgoing.write(payload);
  outgoing.end();
});

const fixture = async (t) => {
  const calls = [];
  const api = {
    session: async (token) => ({ authenticated: token === 'valid' }),
    login: async (password) => {
      calls.push(['login', password]);
      return { cookie: 'awg_easy_3_session=valid; HttpOnly' };
    },
    logout: () => ({ cookie: 'awg_easy_3_session=; Max-Age=0' }),
    listClients: async (token) => {
      calls.push(['list', token]);
      return [{ id: 'phone', name: 'Phone' }];
    },
    createClient: async (token, input) => ({ client: { id: 'new', ...input }, vpnLink: 'vpn://share' }),
    updateClient: async (token, id, input) => ({ id, ...input }),
    deleteClient: async () => ({ success: true }),
    exportClient: async () => ({ contentType: 'text/plain; charset=utf-8', value: 'vpn://share' }),
    changePassword: async () => ({ cookie: 'awg_easy_3_session=; Max-Age=0' }),
  };
  const server = new HttpServer({ api });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  return { calls, port: address.port };
};

test('serves versioned session and client routes with security headers', async (t) => {
  const { calls, port } = await fixture(t);
  const login = await request(port, 'POST', '/api/v1/session', { body: { password: 'secret' } });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  const clients = await request(port, 'GET', '/api/v1/clients', { cookie: 'awg_easy_3_session=valid' });
  assert.equal(clients.status, 200);
  assert.match(clients.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.deepEqual(JSON.parse(clients.body), [{ id: 'phone', name: 'Phone' }]);
  assert.deepEqual(calls, [['login', 'secret'], ['list', 'valid']]);
});

test('supports policy mutation and explicit export routes', async (t) => {
  const { port } = await fixture(t);
  const updated = await request(port, 'PATCH', '/api/v1/clients/phone', {
    body: { networkGroup: 'home', routeMode: 'ru_direct' },
    cookie: 'awg_easy_3_session=valid',
  });
  assert.deepEqual(JSON.parse(updated.body), { id: 'phone', networkGroup: 'home', routeMode: 'ru_direct' });
  const exported = await request(port, 'GET', '/api/v1/clients/phone/export?format=vpn-link', {
    cookie: 'awg_easy_3_session=valid',
  });
  assert.equal(exported.status, 200);
  assert.equal(exported.body, 'vpn://share');
});

test('rejects cross-site mutations, oversized bodies and legacy endpoints', async (t) => {
  const { port } = await fixture(t);
  const crossSite = await request(port, 'POST', '/api/v1/session', {
    body: { password: 'secret' }, headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  const oversized = await request(port, 'POST', '/api/v1/session', {
    body: { password: 'x'.repeat(17 * 1024) },
  });
  assert.equal(oversized.status, 413);
  assert.equal((await request(port, 'GET', '/api/wireguard/backup')).status, 404);
});
