'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { Application } = require('../lib/Application');
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
