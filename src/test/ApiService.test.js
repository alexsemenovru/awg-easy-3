'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ApiService, publicClient } = require('../lib/ApiService');

const SECRET_CLIENT = {
  id: 'phone',
  name: 'Phone',
  enabled: true,
  networkGroup: 'guest',
  routeMode: 'vpn_all',
  address4: '10.8.0.3',
  privateKey: 'private-secret',
  publicKey: 'public-secret',
  presharedKey: 'preshared-secret',
};

const fixture = () => {
  let passwordChanged;
  const clientCalls = [];
  const service = new ApiService({
    store: { load: async () => ({ clients: [SECRET_CLIENT] }) },
    passwordManager: {
      verify: async (password) => password === 'correct-password',
      changePassword: async (current, next) => { passwordChanged = { current, next }; },
    },
    sessionManager: {
      create: async () => 'signed-token',
      verify: async (token) => token === 'signed-token',
      cookie: (token) => `session=${token}; HttpOnly`,
      clearCookie: () => 'session=; Max-Age=0',
    },
    clientManager: {
      createClient: async (input) => {
        clientCalls.push(['create', input]);
        return { client: SECRET_CLIENT, export: { vpnLink: 'vpn://share' } };
      },
      updateClient: async (id, changes) => {
        clientCalls.push(['update', id, changes]);
        return { client: { ...SECRET_CLIENT, ...changes } };
      },
      deleteClient: async (id) => { clientCalls.push(['delete', id]); },
      getClientExport: async () => ({ vpnLink: 'vpn://share', nativeConfig: '[Interface]\nPrivateKey=x' }),
    },
  });
  return { clientCalls, getPasswordChanged: () => passwordChanged, service };
};

test('logs in with a generic failure and an HTTP-only cookie', async () => {
  const { service } = fixture();
  assert.deepEqual(await service.login('correct-password'), {
    authenticated: true,
    cookie: 'session=signed-token; HttpOnly',
  });
  await assert.rejects(service.login('wrong'), (error) => error.statusCode === 401 && /Invalid credentials/.test(error.message));
});

test('never exposes client key material in list or mutations', async () => {
  const { service } = fixture();
  const clients = await service.listClients('signed-token');
  assert.deepEqual(clients, [publicClient(SECRET_CLIENT)]);
  assert.equal(JSON.stringify(clients).includes('secret'), false);

  const created = await service.createClient('signed-token', { name: 'Phone' });
  assert.equal(created.vpnLink, 'vpn://share');
  assert.equal(JSON.stringify(created.client).includes('secret'), false);
  const updated = await service.updateClient('signed-token', 'phone', { networkGroup: 'home' });
  assert.equal(JSON.stringify(updated).includes('secret'), false);
});

test('requires authentication for every client and password operation', async () => {
  const { service } = fixture();
  await assert.rejects(service.listClients('bad-token'), (error) => error.statusCode === 401);
  await assert.rejects(service.createClient('bad-token', { name: 'Phone' }), (error) => error.statusCode === 401);
  await assert.rejects(service.exportClient('bad-token', 'phone', 'vpn-link'), (error) => error.statusCode === 401);
});

test('returns exports only through the explicit authenticated endpoint', async () => {
  const { service } = fixture();
  assert.deepEqual(await service.exportClient('signed-token', 'phone', 'vpn-link'), {
    contentType: 'text/plain; charset=utf-8', value: 'vpn://share',
  });
  assert.match((await service.exportClient('signed-token', 'phone', 'native-config')).value, /PrivateKey/);
  await assert.rejects(service.exportClient('signed-token', 'phone', 'zip'), (error) => error.statusCode === 400);
});

test('changes the password and clears the now-invalid session', async () => {
  const { getPasswordChanged, service } = fixture();
  const result = await service.changePassword('signed-token', 'old-password', 'new-secure-password');
  assert.deepEqual(getPasswordChanged(), { current: 'old-password', next: 'new-secure-password' });
  assert.equal(result.cookie, 'session=; Max-Age=0');
  assert.equal(service.logout().cookie, 'session=; Max-Age=0');
});
