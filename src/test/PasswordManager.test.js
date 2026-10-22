'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { generateOfficialProfile } = require('../lib/Awg3Config');
const { PasswordManager, validatePassword } = require('../lib/PasswordManager');
const { codeAt } = require('../lib/Totp');
const { validateState } = require('../lib/StateStore');
const { SessionManager } = require('../lib/SessionManager');

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

const managerFixture = (initialState = stateFixture()) => {
  let state = initialState;
  let now = 1_800_000_000_000;
  let randomByte = 29;
  const manager = new PasswordManager({
    store: {
      load: async () => state,
      save: async (next) => { state = validateState(next); return state; },
    },
    hash: async (password) => `hash:${password}`,
    compare: async (password, hash) => hash === `hash:${password}`,
    passwordGenerator: () => 'GeneratedPassword234567',
    randomBytes: (length) => Buffer.alloc(length, randomByte++),
    clock: () => now,
  });
  return { getState: () => state, manager, advance: (milliseconds) => { now += milliseconds; }, getNow: () => now };
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

test('enables TOTP, rejects replay, changes modes and resets through SSH', async () => {
  const { getState, manager, advance, getNow } = managerFixture();
  const setup = await manager.beginTotp({ password: 'old-password' });
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  assert.equal(getState().version, 3);
  assert.equal(await manager.authenticate('old-password'), true, 'setup is not active before confirmation');
  const firstCode = codeAt(setup.secret, Math.floor(getNow() / 30_000));
  await manager.confirmTotp('old-password', firstCode);
  assert.equal(getState().auth.mode, 'password_totp');
  assert.equal(await manager.authenticate('old-password', firstCode), false, 'confirmation code cannot be reused');
  advance(30_000);
  const secondCode = codeAt(setup.secret, Math.floor(getNow() / 30_000));
  assert.equal(await manager.authenticate('old-password', secondCode), true);
  assert.equal(await manager.authenticate('old-password', secondCode), false);
  advance(30_000);
  await manager.setMode('totp', { password: 'old-password', code: codeAt(setup.secret, Math.floor(getNow() / 30_000)) });
  assert.equal(await manager.authenticate('old-password'), false);
  assert.equal(await manager.verify('old-password'), false);
  advance(30_000);
  assert.equal(await manager.authenticate(undefined, codeAt(setup.secret, Math.floor(getNow() / 30_000))), true);
  const password = await manager.resetPassword();
  assert.equal(password, 'GeneratedPassword234567');
  assert.equal(getState().auth.mode, undefined);
  assert.equal(getState().auth.totpSecret, undefined);
  assert.equal(await manager.authenticate(password), true);
});

test('requires a fresh code to change modes and a new password to leave code-only', async () => {
  const { manager, advance, getNow, getState } = managerFixture();
  const { secret } = await manager.beginTotp({ password: 'old-password' });
  await manager.confirmTotp('old-password', codeAt(secret, Math.floor(getNow() / 30_000)));
  await assert.rejects(manager.setMode('totp', { password: 'old-password', code: codeAt(secret, Math.floor(getNow() / 30_000)) }), /Invalid credentials/);
  advance(30_000);
  await manager.setMode('totp', { password: 'old-password', code: codeAt(secret, Math.floor(getNow() / 30_000)) });
  advance(30_000);
  await assert.rejects(manager.setMode('password', { code: codeAt(secret, Math.floor(getNow() / 30_000)) }), /between 12 and 128/);
  assert.equal(getState().auth.mode, 'totp', 'failed change must not consume a code');
  await manager.setMode('password', { code: codeAt(secret, Math.floor(getNow() / 30_000)) }, 'NewSecurePassword234');
  assert.equal(getState().auth.totpSecret, undefined);
  assert.equal(await manager.authenticate('NewSecurePassword234'), true);
});

test('TOTP activation and SSH reset invalidate all prior browser sessions', async () => {
  const { manager, getState, getNow } = managerFixture();
  const sessions = new SessionManager({ store: { load: async () => getState() }, clock: getNow });
  const beforeSetup = await sessions.create();
  const { secret } = await manager.beginTotp({ password: 'old-password' });
  assert.equal(await sessions.verify(beforeSetup), true);
  await manager.confirmTotp('old-password', codeAt(secret, Math.floor(getNow() / 30_000)));
  assert.equal(await sessions.verify(beforeSetup), false);
  const afterSetup = await sessions.create();
  await manager.resetPassword();
  assert.equal(await sessions.verify(afterSetup), false);
});

test('TOTP and password changes never downgrade a Cell-capable state', async () => {
  const state = stateFixture();
  state.version = 4;
  const { manager, getState } = managerFixture(state);
  await manager.beginTotp({ password: 'old-password' });
  assert.equal(getState().version, 4);
  await manager.resetPassword();
  assert.equal(getState().version, 4);
});
