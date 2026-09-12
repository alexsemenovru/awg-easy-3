'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ApiService, exportFileName, publicClient } = require('../lib/ApiService');

const SECRET_CLIENT = {
  id: 'phone',
  name: 'Phone',
  enabled: true,
  networkGroup: 'guest',
  address4: '10.8.0.3',
  privateKey: 'private-secret',
  publicKey: 'public-secret',
  presharedKey: 'preshared-secret',
};

const fixture = () => {
  let passwordChanged;
  const clientCalls = [];
  const service = new ApiService({
    store: { load: async () => ({ server: { uiLanguage: 'fa' }, clients: [SECRET_CLIENT] }) },
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
    qrGenerator: async (value) => `<svg data-value="${value}"/>`,
  });
  return { clientCalls, getPasswordChanged: () => passwordChanged, service };
};

test('GeoIP status is authenticated and excludes raw database and internal errors', async () => {
  const { service } = fixture();
  service.geoStatus = () => ({ state: 'ready', release: '2026-09', checkedAt: '2026-09-10T00:00:00Z',
    error: 'private path', database: { internal: true } });
  await assert.rejects(service.geoInfo('wrong'), error => error.statusCode === 401);
  assert.deepEqual(await service.geoInfo('signed-token'), { state: 'ready', release: '2026-09',
    checkedAt: '2026-09-10T00:00:00Z', source: 'DB-IP Lite', sourceUrl: 'https://db-ip.com', countries: [] });
});

test('logs in with a generic failure and an HTTP-only cookie', async () => {
  const { service } = fixture();
  assert.deepEqual(await service.login('correct-password'), {
    authenticated: true,
    cookie: 'session=signed-token; HttpOnly',
  });
  await assert.rejects(service.login('wrong'), (error) => error.statusCode === 401 && /Invalid credentials/.test(error.message));
});

test('exposes the configured UI language without exposing secrets', async () => {
  const { service } = fixture();
  assert.deepEqual(await service.session('bad-token'), { authenticated: false, language: 'fa' });
});

test('never exposes client key material in list or mutations', async () => {
  const { service } = fixture();
  const clients = await service.listClients('signed-token');
  assert.deepEqual(clients, [publicClient(SECRET_CLIENT)]);
  assert.equal(JSON.stringify(clients).includes('secret'), false);

  const created = await service.createClient('signed-token', { name: 'Phone' });
  assert.deepEqual(Object.keys(created), ['client']);
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
  const native = await service.exportClient('signed-token', 'phone', 'native-config');
  assert.equal(native.value, '[Interface]\nPrivateKey=x');
  assert.equal(native.downloadName, 'Phone.conf');
  assert.equal(native.contentType, 'application/octet-stream');
  assert.deepEqual(await service.exportClient('signed-token', 'phone', 'qr-svg'), {
    contentType: 'image/svg+xml; charset=utf-8', value: '<svg data-value="vpn://share"/>',
  });
  await assert.rejects(service.exportClient('signed-token', 'phone', 'zip'), (error) => error.statusCode === 400);
});

test('creates safe readable conf filenames', () => {
  assert.equal(exportFileName(' Honor 50 '), 'Honor_50.conf');
  assert.equal(exportFileName('Home admin'), 'Home_admin.conf');
  assert.equal(exportFileName(' Алексей: телефон '), 'AWG-client.conf');
  assert.equal(exportFileName('///'), 'AWG-client.conf');
  assert.equal(exportFileName('a'.repeat(80)), `${'a'.repeat(15)}.conf`);
  assert.equal(exportFileName(null), 'AWG-client.conf');
  assert.equal(exportFileName('a\r\nb'), 'a_b.conf');
  for (const name of ['CON', 'nul', 'LPT1', '..', '...']) {
    assert.equal(exportFileName(name), 'AWG-client.conf');
  }
  assert.equal(exportFileName('Honor 50+'), 'Honor_50+.conf');
  assert.equal(exportFileName('ＡＷＧ'), 'AWG.conf');
  assert.equal(exportFileName('phone.'), 'phone.conf');
});

test('changes the password and clears the now-invalid session', async () => {
  const { getPasswordChanged, service } = fixture();
  const result = await service.changePassword('signed-token', 'old-password', 'new-secure-password');
  assert.deepEqual(getPasswordChanged(), { current: 'old-password', next: 'new-secure-password' });
  assert.equal(result.cookie, 'session=; Max-Age=0');
  assert.equal(service.logout().cookie, 'session=; Max-Age=0');
});
