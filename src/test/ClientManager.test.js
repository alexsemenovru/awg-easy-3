'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { generateOfficialProfile } = require('../lib/Awg3Config');
const { ClientManager } = require('../lib/ClientManager');
const { validateState } = require('../lib/StateStore');

const profile = () => generateOfficialProfile({
  randomInt: (() => {
    const values = [20, 30, 40, 5];
    return () => values.shift();
  })(),
  generateKey: () => Buffer.alloc(32, 31).toString('base64'),
});

const initialState = () => validateState({
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
    profile: profile(),
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

const fixture = () => {
  let state = initialState();
  const applications = [];
  const manager = new ClientManager({
    store: {
      load: async () => state,
      save: async (next) => { state = validateState(next); return state; },
    },
    applier: { apply: async (input) => { applications.push(input); } },
    keyManager: {
      generatePeerKeys: async () => ({
        privateKey: 'guest-private', publicKey: 'guest-public', presharedKey: 'guest-psk',
      }),
    },
    idGenerator: () => 'new-client',
  });
  return { applications, getState: () => state, manager };
};

test('creates a guest by default and returns its AmneziaVPN export', async () => {
  const { applications, getState, manager } = fixture();
  const result = await manager.createClient({ name: 'Guest phone' });
  assert.equal(result.client.networkGroup, 'guest');
  assert.equal(result.client.address4, '10.8.0.3');
  assert.match(result.export.vpnLink, /^vpn:\/\//);
  assert.equal(getState().clients.length, 2);
  assert.equal(applications.length, 1);
  assert.equal(applications[0].interfaceActive, true);
});

test('switches network policy and blocks unsafe fields', async () => {
  const { manager } = fixture();
  await manager.createClient({ name: 'Phone' });
  const result = await manager.updateClient('new-client', { networkGroup: 'home' });
  assert.equal(result.client.networkGroup, 'home');
  assert.match(result.export.nativeConfig, /AllowedIPs = 0\.0\.0\.0\/0/);
  await assert.rejects(manager.updateClient('new-client', { publicKey: 'replacement' }), /cannot be changed/);
});

test('protects the last active home client from update and deletion', async () => {
  const { manager } = fixture();
  await assert.rejects(manager.updateClient('home-admin', { networkGroup: 'guest' }), /home client/);
  await assert.rejects(manager.updateClient('home-admin', { enabled: false }), /home client/);
  await assert.rejects(manager.deleteClient('home-admin'), /home client/);
});

test('restores the previous runtime when state persistence fails', async () => {
  let state = initialState();
  const applications = [];
  const manager = new ClientManager({
    store: {
      load: async () => state,
      save: async () => { throw new Error('disk full'); },
    },
    applier: { apply: async (input) => { applications.push(input); } },
    keyManager: {
      generatePeerKeys: async () => ({
        privateKey: 'guest-private', publicKey: 'guest-public', presharedKey: 'guest-psk',
      }),
    },
    idGenerator: () => 'new-client',
  });
  await assert.rejects(manager.createClient({ name: 'Guest' }), /disk full/);
  assert.equal(applications.length, 2);
  assert.match(applications[0].serverConfig, /Guest/);
  assert.doesNotMatch(applications[1].serverConfig, /Guest/);
  assert.equal(state.clients.length, 1);
});
