'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateOfficialProfile } = require('../lib/Awg3Config');
const { StateStore, validateState } = require('../lib/StateStore');

const fixture = () => ({
  version: 1,
  auth: {
    passwordHash: 'argon2id-hash-placeholder',
    sessionSecret: 'session-secret-placeholder',
  },
  server: {
    interfaceName: 'awg0',
    wanInterface: 'eth0',
    privateKey: 'server-private-key',
    publicKey: 'server-public-key',
    address4: '10.8.0.1',
    ipv4Subnet: '10.8.0.0/24',
    listenPort: 51820,
    panelPort: 51821,
    uiLanguage: 'en',
    endpointHost: 'vpn.example.com',
    profile: generateOfficialProfile({
      randomInt: (() => {
        const values = [20, 30, 40, 5];
        return () => values.shift();
      })(),
      generateKey: () => Buffer.alloc(32, 13).toString('base64'),
    }),
  },
  clients: [{
    id: 'admin',
    name: 'Admin phone',
    enabled: true,
    networkGroup: 'home',
    address4: '10.8.0.2',
    privateKey: 'admin-private-key',
    publicKey: 'admin-public-key',
    presharedKey: 'admin-psk',
  }],
});

test('validates and deeply freezes versioned clean-install state', () => {
  const state = validateState(fixture());
  assert.equal(state.version, 1);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.server.profile), true);
  assert.equal(Object.isFrozen(state.clients[0]), true);
});

test('atomically saves and loads state without losing secrets', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-easy-3-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  const store = new StateStore(filePath);

  assert.equal(await store.load(), null);
  await store.save(fixture());
  const loaded = await store.load();
  assert.equal(loaded.server.privateKey, 'server-private-key');
  assert.equal(loaded.clients[0].privateKey, 'admin-private-key');

  if (process.platform !== 'win32') {
    const stats = await fs.stat(filePath);
    assert.equal(stats.mode & 0o777, 0o600);
  }
});

test('rejects unsupported versions instead of attempting migration', () => {
  const state = fixture();
  state.version = 2;
  assert.throws(() => validateState(state), /Unsupported state version/);
});

test('rejects duplicate peers and a state without an active home client', () => {
  const duplicate = fixture();
  duplicate.clients.push({ ...duplicate.clients[0], id: 'second' });
  assert.throws(() => validateState(duplicate), /Duplicate client address4/);

  const lockedOut = fixture();
  lockedOut.clients[0].enabled = false;
  assert.throws(() => validateState(lockedOut), /enabled home/);
});

test('accepts supported UI languages and rejects unknown ones', () => {
  for (const language of ['en', 'ru', 'fa']) {
    const state = fixture();
    state.server.uiLanguage = language;
    assert.equal(validateState(state).server.uiLanguage, language);
  }
  const invalid = fixture();
  invalid.server.uiLanguage = 'de';
  assert.throws(() => validateState(invalid), /uiLanguage/);
});

test('reports corrupted JSON without replacing it', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-easy-3-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  await fs.writeFile(filePath, '{broken');
  const store = new StateStore(filePath);
  await assert.rejects(() => store.load(), /not valid JSON/);
  assert.equal(await fs.readFile(filePath, 'utf8'), '{broken');
});
