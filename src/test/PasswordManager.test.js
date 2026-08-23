'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { generateOfficialProfile } = require('../lib/Awg3Config');
const { PasswordManager, validatePassword } = require('../lib/PasswordManager');

const stateFixture = () => ({
  version: 1,
  auth: { passwordHash: 'hash:old-password', sessionSecret: 'old-session-secret' },
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
      randomInt: (() => {
        const values = [20, 30, 40, 5];
        return () => values.shift();
      })(),
      generateKey: () => Buffer.alloc(32, 23).toString('base64'),
    }),
  },
  clients: [{
    id: 'home-admin',
    name: 'Home admin',
    enabled: true,
    networkGroup: 'home',
    address4: '10.8.0.2',
    privateKey: 'client-private',
    publicKey: 'client-public',
  }],
});

const managerFixture = () => {
  let state = stateFixture();
  const manager = new PasswordManager({
    store: {
      load: async () => state,
      save: async (next) => { state = next; return next; },
    },
    hash: async (password) => `hash:${password}`,
    compare: async (password, hash) => hash === `hash:${password}`,
    passwordGenerator: () => 'GeneratedPassword234567',
    randomBytes: () => Buffer.alloc(48, 29),
  });
  return { getState: () => state, manager };
};

test('verifies the single panel password', async () => {
  const { manager } = managerFixture();
  assert.equal(await manager.verify('old-password'), true);
  assert.equal(await manager.verify('wrong-password'), false);
  assert.equal(await manager.verify(undefined), false);
});

test('changes password and invalidates every existing session', async () => {
  const { getState, manager } = managerFixture();
  await manager.changePassword('old-password', 'NewSecurePassword234');
  assert.equal(getState().auth.passwordHash, 'hash:NewSecurePassword234');
  assert.equal(getState().auth.sessionSecret, Buffer.alloc(48, 29).toString('base64url'));
  assert.notEqual(getState().auth.sessionSecret, 'old-session-secret');
  await assert.rejects(manager.changePassword('wrong', 'AnotherSecurePassword'), /incorrect/);
});

test('supports a local reset and returns a generated password once', async () => {
  const { getState, manager } = managerFixture();
  const password = await manager.resetPassword();
  assert.equal(password, 'GeneratedPassword234567');
  assert.equal(getState().auth.passwordHash, 'hash:GeneratedPassword234567');
});

test('enforces a practical password boundary', () => {
  assert.equal(validatePassword('twelve-chars'), 'twelve-chars');
  assert.throws(() => validatePassword('short'), /between 12 and 128/);
  assert.throws(() => validatePassword('valid-length\nbut-line'), /line breaks/);
});
