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
  state.version = 5;
  assert.throws(() => validateState(state), /Unsupported state version/);
});

test('Cell entry is version-gated and keeps a remote IPv6 address independent of Main IPv6', () => {
  const state = fixture();
  state.clients.push({ ...state.clients[0], id: 'remote', name: 'Remote phone',
    networkGroup: 'guest', entryCellId: 'a'.repeat(32),
    address4: '10.64.0.2', address6: 'fd64::2',
    privateKey: 'remote-private', publicKey: 'remote-public',
    ipv4Enabled: true, ipv6Enabled: true });
  assert.throws(() => validateState(state), /Cell entry requires state version 4/);
  state.version = 4;
  const saved = validateState(state);
  assert.equal(saved.version, 4);
  assert.equal(saved.clients[1].entryCellId, 'a'.repeat(32));
  assert.equal(saved.clients[1].ipv6Enabled, true);
  assert.equal(validateState({ ...saved, clients: saved.clients.slice(0, 1) }).version, 4);
});

test('rejects TOTP configuration in formats an old panel could read', () => {
  const state = fixture();
  state.auth.mode = 'password_totp';
  state.auth.totpSecret = 'A'.repeat(32);
  assert.throws(() => validateState(state), /requires state version 3/);
  state.version = 3;
  assert.equal(validateState(state).auth.mode, 'password_totp');
});

test('GeoIP upgrades persisted format without changing keys and never silently downgrades', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-geo-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  const store = new StateStore(filePath);
  const original = fixture();
  original.clients[0].geoPolicy = { mode: 'off', countries: [] };
  assert.equal((await store.save(original)).version, 1);
  original.clients[0].geoPolicy = { mode: 'block', countries: ['RU'] };
  const saved = await store.save(original);
  assert.equal(saved.version, 2);
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).version, 2);
  assert.equal((await store.load()).clients[0].privateKey, original.clients[0].privateKey);
  const disabled = { ...saved, clients: saved.clients.map(c => ({ ...c, geoPolicy: { mode: 'off', countries: [] } })) };
  await store.save(disabled);
  assert.equal((await store.load()).version, 2);
  assert.equal((await store.load()).server.privateKey, original.server.privateKey);
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
  for (const language of ['en', 'ru', 'fa', 'es', 'zh-cn']) {
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
