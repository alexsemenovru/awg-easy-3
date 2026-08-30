'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const { clientTraffic, changeClientTraffic, assertCurrentPanelPathRemains } = require('../lib/ClientTraffic');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { StateStore, validateState } = require('../lib/StateStore');
const { buildAwgArtifacts } = require('../lib/AwgArtifacts');
const { ClientManager } = require('../lib/ClientManager');
const { ApiService, publicClient } = require('../lib/ApiService');
const { HttpServer } = require('../lib/HttpServer');
const { Application } = require('../lib/Application');
const { DiscoveryRelay, SERVICES } = require('../lib/DiscoveryRelay');

const legacyState = () => ({
  version: 1, auth: { passwordHash: 'test-hash', sessionSecret: 'test-secret' },
  server: {
    interfaceName: 'awg0', wanInterface: 'eth0', privateKey: 'server-private', publicKey: 'server-public',
    address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24', address6: 'fd42:8::1', ipv6Subnet: 'fd42:8::/64',
    listenPort: 42123, panelPort: 51821, endpointHost: 'vpn.example.com', ipv6Mode: 'nat66',
    profile: generateOfficialProfile({
      randomInt: (() => { const values = [20, 30, 40, 5]; return () => values.shift(); })(),
      generateKey: () => Buffer.alloc(32, 23).toString('base64'),
    }),
  },
  clients: ['admin', 'phone', 'guest', 'disabled'].map((id, index) => ({
    id, name: id, networkGroup: index < 2 ? 'home' : 'guest', enabled: id !== 'disabled',
    address4: `10.8.0.${index + 2}`, address6: `fd42:8::${index + 2}`,
    privateKey: `${id}-private`, publicKey: `${id}-public`, presharedKey: `${id}-psk`,
  })),
});
const fixture = () => {
  let state = validateState(legacyState());
  const applications = [], changes = [];
  const store = { load: async () => state, save: async (next) => { state = validateState(next); return state; } };
  const manager = new ClientManager({
    store, applier: { apply: async (value) => applications.push(value) },
    onStateChanged: (value) => changes.push(value),
    idGenerator: () => 'new', keyManager: { generatePeerKeys: async () => ({ privateKey: 'new-private', publicKey: 'new-public' }) },
  });
  return { store, manager, applications, changes, state: () => state };
};
const code = (expected) => (error) => error.code === expected && error.statusCode === 409;
const members = (policy, name) => {
  const body = policy.match(new RegExp(`set ${name} \\{([^]*?)\\n  \\}`))?.[1];
  assert.ok(body, `missing ${name}`);
  return body.match(/elements = \{ (.*?) \}/)?.[1].split(', ') ?? [];
};

test('legacy permissions migrate without changing keys, addresses or disabled peers', () => {
  const old = legacyState();
  const state = validateState(old);
  for (let i = 0; i < old.clients.length; i += 1) {
    const before = old.clients[i], after = state.clients[i];
    assert.deepEqual(after, { ...before, ipv4Enabled: before.enabled, ipv6Enabled: before.enabled });
  }
  assert.deepEqual(state.server.profile, old.server.profile);
  const ipv4 = legacyState();
  delete ipv4.server.address6; delete ipv4.server.ipv6Subnet; delete ipv4.server.ipv6Mode;
  ipv4.clients.forEach((client) => { delete client.address6; });
  assert.deepEqual(clientTraffic(validateState(ipv4).clients[0]), { enabled: true, ipv4Enabled: true, ipv6Enabled: false });
});

test('all four combinations derive enabled from the family flags, not legacy enabled', () => {
  for (const ipv4Enabled of [false, true]) for (const ipv6Enabled of [false, true]) {
    assert.deepEqual(clientTraffic({ address6: 'fd42:8::2', enabled: false, ipv4Enabled, ipv6Enabled }), {
      ipv4Enabled, ipv6Enabled, enabled: ipv4Enabled || ipv6Enabled,
    });
  }
  for (const value of [null, 1, 'false']) assert.throws(() => clientTraffic({ enabled: value }), /boolean/);
  assert.throws(() => clientTraffic({ ipv4Enabled: true }), /stored together/);
  assert.throws(() => changeClientTraffic({}, { enabled: true, ipv4Enabled: false }), /combine/);
  assert.throws(() => changeClientTraffic({}, { ipv6Enabled: true }), code('IPV6_UNAVAILABLE'));
});

test('state rejects incomplete IPv6 capability rather than displaying an unusable switch', () => {
  const state = legacyState();
  delete state.server.ipv6Subnet;
  assert.throws(() => validateState(state), /configured together/);
  delete state.server.address6; delete state.server.ipv6Mode;
  assert.throws(() => validateState(state), /requires server IPv6/);
});

test('persisted partial permissions fail closed for older readers and survive restart', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-family-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'), store = new StateStore(file);
  const state = legacyState();
  state.clients[0] = changeClientTraffic(state.clients[0], { ipv4Enabled: false });
  state.clients[1] = changeClientTraffic(state.clients[1], { ipv6Enabled: false });
  await store.save(state);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(persisted.clients[0].enabled, false);
  assert.equal(persisted.clients[1].enabled, false);
  assert.equal(persisted.clients[2].enabled, true);
  const loaded = await store.load();
  assert.equal(loaded.clients[0].enabled, true);
  assert.equal(loaded.clients[0].ipv4Enabled, false);
  assert.equal(loaded.clients[1].ipv6Enabled, false);
  assert.deepEqual(buildAwgArtifacts(loaded).clientArtifacts, buildAwgArtifacts(legacyState()).clientArtifacts);
});

test('switches permissions without changing the exported profile, addresses, keys, DNS or routes', async () => {
  const f = fixture();
  const before = await f.manager.getClientExport('phone');
  for (const [ipv4Enabled, ipv6Enabled] of [[false, true], [true, false], [false, false], [true, true]]) {
    const result = await f.manager.updateClient('phone', { ipv4Enabled, ipv6Enabled });
    assert.deepEqual(result.export, before);
    assert.equal(result.client.enabled, ipv4Enabled || ipv6Enabled);
    assert.equal(result.client.networkGroup, 'home');
    const artifacts = buildAwgArtifacts(f.state());
    assert.equal(artifacts.serverConfig.includes('phone-public'), ipv4Enabled || ipv6Enabled);
    if (result.client.enabled) assert.match(artifacts.serverConfig, /AllowedIPs = 10\.8\.0\.3\/32, fd42:8::3\/128/);
    assert.equal(members(artifacts.nftables, 'active4').includes('10.8.0.3'), ipv4Enabled);
    assert.equal(members(artifacts.nftables, 'home4').includes('10.8.0.3'), ipv4Enabled);
    assert.equal(members(artifacts.nftables, 'active6').includes('fd42:8::3'), ipv6Enabled);
  }
  assert.equal(f.changes.length, 4);
});

test('new peers default to both supported families; Home/Guest changes keep permissions', async () => {
  const f = fixture();
  const created = await f.manager.createClient({ name: 'New phone' });
  assert.equal(created.client.ipv4Enabled, true);
  assert.equal(created.client.ipv6Enabled, true);
  assert.equal(created.client.networkGroup, 'guest');
  await f.manager.updateClient('new', { ipv4Enabled: false });
  const result = await f.manager.updateClient('new', { networkGroup: 'home' });
  assert.equal(result.client.ipv4Enabled, false);
  assert.equal(result.client.ipv6Enabled, true);
  assert.equal(members(f.applications.at(-1).nftables, 'home6').includes(result.client.address6), true);
});

test('legacy API enable/disable remains explicit and mixed payloads are rejected', async () => {
  const f = fixture();
  await f.manager.updateClient('phone', { ipv4Enabled: false });
  const off = (await f.manager.updateClient('phone', { enabled: false })).client;
  assert.deepEqual(clientTraffic(off), { ipv4Enabled: false, ipv6Enabled: false, enabled: false });
  const on = (await f.manager.updateClient('phone', { enabled: true })).client;
  assert.deepEqual(clientTraffic(on), { ipv4Enabled: true, ipv6Enabled: true, enabled: true });
  await assert.rejects(f.manager.updateClient('phone', { enabled: true, ipv6Enabled: false }), /combine/);
  await assert.rejects(f.manager.updateClient('phone', { ipv4Enabled: null }), /boolean/);
});

test('the last Home can become IPv6-only but cannot be disabled, demoted or deleted', async () => {
  const f = fixture();
  await f.manager.updateClient('phone', { networkGroup: 'guest' });
  await f.manager.updateClient('admin', { ipv4Enabled: false });
  const rules = f.applications.at(-1).nftables;
  assert.deepEqual(members(rules, 'home4'), []);
  assert.deepEqual(members(rules, 'home6'), ['fd42:8::2']);
  await assert.rejects(f.manager.updateClient('admin', { ipv6Enabled: false }), code('LAST_HOME'));
  await assert.rejects(f.manager.updateClient('admin', { networkGroup: 'guest' }), code('LAST_HOME'));
  await assert.rejects(f.manager.deleteClient('admin'), code('LAST_HOME'));
  assert.equal(f.applications.length, 2, 'rejections must not touch the runtime');
});

test('current administration path is protected using canonical socket addresses', async () => {
  const f = fixture();
  for (const remoteAddress of ['10.8.0.3', '::ffff:10.8.0.3', '::ffff:a08:3']) {
    await assert.rejects(f.manager.updateClient('phone', { ipv4Enabled: false }, { remoteAddress }), code('CURRENT_PANEL_PATH'));
    await assert.rejects(f.manager.deleteClient('phone', { remoteAddress }), code('CURRENT_PANEL_PATH'));
    await assert.rejects(f.manager.updateClient('phone', { networkGroup: 'guest' }, { remoteAddress }), code('CURRENT_PANEL_PATH'));
  }
  await assert.rejects(f.manager.updateClient('phone', { ipv6Enabled: false }, {
    remoteAddress: 'FD42:0008:0:0:0:0:0:0003',
  }), code('CURRENT_PANEL_PATH'));
  assert.equal(f.applications.length, 0);
  await f.manager.updateClient('phone', { ipv4Enabled: false }, { remoteAddress: 'fd42:8::3' });
  await f.manager.updateClient('phone', { ipv4Enabled: true }, { remoteAddress: 'fd42:8::3' });
  await f.manager.updateClient('phone', { ipv6Enabled: false }, { remoteAddress: '10.8.0.3' });
  assert.doesNotThrow(() => assertCurrentPanelPathRemains(f.state().clients[1], null, 'not-an-address'));
});

test('failed persistence restores the old family policy and does not refresh discovery', async () => {
  const f = fixture();
  const before = buildAwgArtifacts(f.state());
  f.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(f.manager.updateClient('phone', { ipv6Enabled: false }), /disk full/);
  assert.equal(f.applications.length, 2);
  assert.equal(f.applications[1].nftables, before.nftables);
  assert.equal(f.applications[1].serverConfig, before.serverConfig);
  assert.equal(f.changes.length, 0);
  assert.equal(f.state().clients[1].ipv6Enabled, true);
});

test('permission gates precede all permits on input, forward and output and stay interface scoped', () => {
  const { nftables } = buildAwgArtifacts(validateState(legacyState()));
  for (const hook of ['input', 'forward', 'output']) {
    assert.match(nftables, new RegExp(`chain ${hook} \\{\\s+type filter hook ${hook} priority -10; policy accept;\\s+jump client_permissions`));
  }
  const gate = nftables.match(/chain client_permissions \{([^]*?)\n  \}/)[1];
  assert.equal(gate.trim().split('\n').length, 4);
  for (const [family, qualifier] of [[4, 'ip'], [6, 'ip6']]) {
    assert.ok(gate.includes(`iifname "awg0" ${qualifier} saddr != @active${family} drop`));
    assert.ok(gate.includes(`oifname "awg0" ${qualifier} daddr != @active${family} drop`));
  }
  assert.doesNotMatch(nftables, /flush ruleset/);
});

test('revoking IPv4 or Home immediately removes cached discovery requesters', () => {
  for (const changes of [{ ipv4Enabled: false }, { networkGroup: 'guest' }]) {
    let state = validateState(legacyState());
    const relay = new DiscoveryRelay();
    relay.refresh(state);
    const ssdp = SERVICES.find((service) => service.name === 'ssdp4');
    relay.targets(ssdp, { address: '10.8.0.3', port: 40000 });
    state = validateState({ ...state, clients: state.clients.map((client) => client.id === 'phone' ? changeClientTraffic(client, changes) : client) });
    relay.refresh(state);
    assert.deepEqual(relay.targets(ssdp, { address: '10.8.0.2', port: 1900 }), []);
    assert.deepEqual(relay.targets(ssdp, { address: '10.8.0.3', port: 40000 }), []);
  }
});

test('network info and permissions are authenticated and do not expose key material', async () => {
  const f = fixture();
  const api = new ApiService({
    store: f.store, clientManager: f.manager,
    passwordManager: { verify: async () => true, changePassword: async () => {} },
    sessionManager: { create: async () => 'token', verify: async (token) => token === 'valid' },
  });
  await assert.rejects(api.networkInfo('invalid'), (error) => error.statusCode === 401);
  assert.deepEqual(await api.networkInfo('valid'), {
    panelIpv4Url: 'http://10.8.0.1:51821/', panelIpv6Url: 'http://[fd42:8::1]:51821/',
  });
  const client = publicClient(f.state().clients[0]);
  assert.equal(client.ipv6Available, true);
  assert.doesNotMatch(JSON.stringify(client), /private|psk|publicKey/);
  await assert.rejects(api.updateClient('valid', 'phone', { ipv4Enabled: false }, {
    remoteAddress: '10.8.0.3',
  }), code('CURRENT_PANEL_PATH'));
});

test('HTTP uses the socket peer, ignores forged forwarding headers and returns a safe error code', async (t) => {
  const seen = [];
  const server = new HttpServer({ api: {
    updateClient: async (_token, _id, _input, context) => {
      seen.push(context.remoteAddress);
      assertCurrentPanelPathRemains({ address4: '127.0.0.1', networkGroup: 'home' }, null, context.remoteAddress);
    },
    deleteClient: async (_token, _id, context) => {
      seen.push(context.remoteAddress);
      assertCurrentPanelPathRemains({ address4: '127.0.0.1', networkGroup: 'home' }, null, context.remoteAddress);
    },
  } });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  for (const method of ['PATCH', 'DELETE']) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: address.port, method, path: '/api/v1/clients/admin',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2, 'X-Forwarded-For': '10.8.0.99', Forwarded: 'for=10.8.0.99' },
      }, (incoming) => {
        let body = ''; incoming.on('data', (chunk) => { body += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(body) }));
      });
      request.on('error', reject); request.end('{}');
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'CURRENT_PANEL_PATH');
  }
  assert.deepEqual(seen, ['127.0.0.1', '127.0.0.1']);
});

test('panel binds only the two internal addresses, shares API, and cleans up after IPv6 bind failure', async () => {
  for (const fail6 of [false, true]) {
    const binds = [], closed = [], apis = [], shutdown = [];
    const state = validateState(legacyState());
    const application = new Application({
      httpFactory: ({ api }) => {
        const index = apis.push(api) - 1;
        return { listen: async (options) => {
          binds.push(options);
          if (fail6 && index === 1) throw new Error('IPv6 bind failed');
          return options;
        }, close: async () => { closed.push(index); } };
      },
      discoveryFactory: () => ({ start: async () => {}, stop: async () => shutdown.push('discovery') }),
    });
    application.store = { load: async () => state, save: async (value) => value };
    application.interfaceActive = async () => false;
    application.applier = { apply: async () => {}, down: async () => shutdown.push('runtime') };
    if (fail6) await assert.rejects(application.start(), /IPv6 bind failed/);
    else { await application.start(); await application.stop(); }
    assert.deepEqual(binds, [{ host: '10.8.0.1', port: 51821 }, { host: 'fd42:8::1', port: 51821 }]);
    assert.equal(apis[0], apis[1]);
    assert.deepEqual(closed, [0, 1]);
    assert.deepEqual(shutdown, ['discovery', 'runtime']);
    assert.equal(application.state, null);
  }
});

test('HTTP over a real IPv6 loopback connection accepts bracketed origins and protects that path', async (t) => {
  const server = new HttpServer({ api: {
    updateClient: async (_token, _id, _changes, context) => {
      assert.equal(context.remoteAddress, '::1');
      assertCurrentPanelPathRemains({ address4: '127.0.0.2', address6: '::1', networkGroup: 'home' }, null, context.remoteAddress);
    },
  } });
  let address;
  try { address = await server.listen({ host: '::1', port: 0 }); }
  catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) return t.skip('IPv6 loopback unavailable on this test host');
    throw error;
  }
  t.after(() => server.close());
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: '::1', port: address.port, method: 'PATCH', path: '/api/v1/clients/admin',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2, Origin: `http://[::1]:${address.port}` },
    }, (incoming) => {
      let body = ''; incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'CURRENT_PANEL_PATH');
});
