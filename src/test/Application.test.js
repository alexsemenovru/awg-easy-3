'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { Application } = require('../lib/Application');
const { decodeVpnLink } = require('../lib/AmneziaVpnLink');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { validateState } = require('../lib/StateStore');

const stateFixture = () => validateState({
  version: 1,
  auth: { passwordHash: 'password-hash', sessionSecret: 'session-secret' },
  server: {
    interfaceName: 'awg0',
    wanInterface: 'eth0',
    privateKey: 'server-private',
    publicKey: 'server-public',
    address4: '10.8.0.1',
    ipv4Subnet: '10.8.0.0/24',
    listenPort: 51820,
    panelPort: 51821,
    endpointHost: 'vpn.example.com',
    profile: generateOfficialProfile({
      randomInt: (() => { const values = [20, 30, 40, 5]; return () => values.shift(); })(),
      generateKey: () => Buffer.alloc(32, 41).toString('base64'),
    }),
  },
  clients: [{
    id: 'home-admin',
    name: 'Home admin',
    enabled: true,
    networkGroup: 'home',
    address4: '10.8.0.2',
    privateKey: 'admin-private',
    publicKey: 'admin-public',
    presharedKey: 'admin-psk',
  }],
});

const fixture = ({ discoveryStart, httpListen } = {}) => {
  const calls = [];
  const discovery = {
    start: async (state) => { calls.push(['discovery-start', state.server.interfaceName]); return discoveryStart?.(); },
    refresh: () => {},
    stop: async () => { calls.push(['discovery-stop']); },
  };
  const http = {
    listen: async () => { calls.push(['http-listen']); return httpListen?.() ?? { address: '10.8.0.1', port: 51821 }; },
    close: async () => { calls.push(['http-close']); },
  };
  const application = new Application({
    discoveryFactory: () => discovery,
    httpFactory: () => http,
  });
  application.store = { load: async () => stateFixture(), save: async (state) => state };
  application.applier = {
    apply: async () => { calls.push(['runtime-apply']); },
    down: async ({ interfaceName }) => { calls.push(['runtime-down', interfaceName]); },
  };
  application.interfaceActive = async () => false;
  return { application, calls };
};

test('rolls runtime back when discovery startup fails', async () => {
  const { application, calls } = fixture({ discoveryStart: () => { throw new Error('discovery failed'); } });
  await assert.rejects(application.start(), /discovery failed/);
  assert.deepEqual(calls, [
    ['runtime-apply'],
    ['discovery-start', 'awg0'],
    ['discovery-stop'],
    ['runtime-down', 'awg0'],
  ]);
  assert.equal(application.state, null);
});

test('closes discovery and runtime when panel bind fails', async () => {
  const { application, calls } = fixture({ httpListen: () => { throw new Error('address in use'); } });
  await assert.rejects(application.start(), /address in use/);
  assert.deepEqual(calls, [
    ['runtime-apply'],
    ['discovery-start', 'awg0'],
    ['http-listen'],
    ['http-close'],
    ['discovery-stop'],
    ['runtime-down', 'awg0'],
  ]);
  assert.equal(application.state, null);
});

test('re-exports an existing client by name or ID without changing state', async () => {
  const { application } = fixture();
  const byName = await application.exportClient('home ADMIN');
  const byId = await application.exportClient('home-admin');
  assert.equal(byName.clientName, 'Home admin');
  assert.match(byName.vpnLink, /^vpn:\/\//);
  assert.equal(byId.vpnLink, byName.vpnLink);
  await assert.rejects(application.exportClient('missing'), /Unknown client/);
  await assert.rejects(application.exportClient(''), /required/);
});

test('restart and client export use the persisted random UDP port', async () => {
  const { application } = fixture();
  const base = stateFixture();
  const state = validateState({ ...base, server: { ...base.server, listenPort: 42123 } });
  application.store.load = async () => state;
  const applied = [];
  application.applier.apply = async (artifacts) => applied.push(artifacts);
  await application.start();
  await application.stop();
  await application.start();
  assert.equal(applied.length, 2);
  for (const artifacts of applied) {
    assert.match(artifacts.serverConfig, /ListenPort = 42123/);
    assert.match(artifacts.nftables, /tcp dport 51821/);
  }
  const exported = decodeVpnLink((await application.exportClient('home-admin')).vpnLink);
  const config = JSON.parse(exported.containers[0].awg.last_config).config;
  assert.match(config, /Endpoint = vpn\.example\.com:42123/);
  await application.stop();
});

test('settings reports only saved public settings and does not start the runtime', async () => {
  const { application, calls } = fixture();
  const base = stateFixture();
  application.store.load = async () => validateState({
    ...base, server: { ...base.server, listenPort: 42123, panelPort: 8080, uiLanguage: 'ru' },
  });
  assert.deepEqual(await application.settings(), {
    AWG_HOST: 'vpn.example.com', AWG_PORT: 42123, AWG_PANEL_PORT: 8080, AWG_LANG: 'ru',
  });
  assert.deepEqual(calls, []);
  application.store.load = async () => null;
  await assert.rejects(application.settings(), /not initialized/);
});
