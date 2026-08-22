'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { generateOfficialProfile } = require('../lib/Awg3Config');
const { BootstrapInstaller, PASSWORD_ALPHABET, generatePassword } = require('../lib/BootstrapInstaller');

const PRIVATE_SERVER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const PUBLIC_SERVER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const PRIVATE_CLIENT = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';
const PUBLIC_CLIENT = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=';
const PSK = 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=';

const profile = () => generateOfficialProfile({
  randomInt: (() => {
    const values = [20, 30, 40, 5];
    return () => values.shift();
  })(),
  generateKey: () => Buffer.alloc(32, 17).toString('base64'),
});

const dependencies = (existing = null) => {
  let saved;
  return {
    getSaved: () => saved,
    options: {
      store: {
        load: async () => existing,
        save: async (state) => { saved = state; return state; },
      },
      keyManager: {
        generateKeyPair: async () => ({ privateKey: PRIVATE_SERVER, publicKey: PUBLIC_SERVER }),
        generatePeerKeys: async () => ({
          privateKey: PRIVATE_CLIENT,
          publicKey: PUBLIC_CLIENT,
          presharedKey: PSK,
        }),
      },
      passwordGenerator: () => 'CorrectHorseBatteryStaple',
      passwordHasher: async (password) => {
        assert.equal(password, 'CorrectHorseBatteryStaple');
        return '$2a$12$test-password-hash';
      },
      randomBytes: (length) => Buffer.alloc(length, 19),
      profileGenerator: profile,
      networkDetector: {
        detect: async () => ({
          wanInterface: 'detected0',
          endpointCandidate: '198.51.100.50',
          ipv6: { available: false },
        }),
      },
    },
  };
};

test('creates the clean installation and first home profile', async () => {
  const fixture = dependencies();
  const installer = new BootstrapInstaller(fixture.options);
  const result = await installer.install({
    endpointHost: 'vpn.example.com',
    wanInterface: 'ens3',
  });

  assert.equal(result.bootstrapPassword, 'CorrectHorseBatteryStaple');
  assert.equal(result.state.auth.passwordHash, '$2a$12$test-password-hash');
  assert.equal(result.state.auth.sessionSecret, Buffer.alloc(48, 19).toString('base64url'));
  assert.equal(result.state.server.address4, '10.8.0.1');
  assert.equal(result.state.clients[0].address4, '10.8.0.2');
  assert.equal(result.state.clients[0].networkGroup, 'home');
  assert.equal(result.state.clients[0].routeMode, 'vpn_all');
  assert.equal(fixture.getSaved(), result.state);
  assert.equal(JSON.stringify(result.state).includes(result.bootstrapPassword), false);
});

test('adds IPv6 only when automatic detection supplies a routed prefix', async () => {
  const fixture = dependencies();
  const result = await new BootstrapInstaller(fixture.options).install({
    endpointHost: '2001:db8::10',
    wanInterface: 'eth0',
    ipv6: {
      subnet: '2001:db8:42::/64',
      serverAddress: '2001:db8:42::1',
      firstClientAddress: '2001:db8:42::2',
    },
  });
  assert.equal(result.state.server.address6, '2001:db8:42::1');
  assert.equal(result.state.server.ipv6Mode, 'routed');
  assert.equal(result.state.clients[0].address6, '2001:db8:42::2');
});

test('automatically creates a NAT66 ULA plan when VPS IPv6 works', async () => {
  const fixture = dependencies();
  fixture.options.networkDetector.detect = async () => ({
    wanInterface: 'ens3',
    endpointCandidate: '203.0.113.50',
    ipv6: { available: true },
  });
  const result = await new BootstrapInstaller(fixture.options).install({});
  assert.equal(result.state.server.wanInterface, 'ens3');
  assert.equal(result.state.server.endpointHost, '203.0.113.50');
  assert.equal(result.state.server.ipv6Mode, 'nat66');
  assert.equal(result.state.server.ipv6Subnet, 'fd13:1313:1313::/64');
  assert.equal(result.state.clients[0].address6, 'fd13:1313:1313::2');
});

test('refuses to overwrite an existing installation before generating secrets', async () => {
  const fixture = dependencies({ version: 1 });
  let generated = false;
  fixture.options.keyManager.generateKeyPair = async () => { generated = true; return {}; };
  const installer = new BootstrapInstaller(fixture.options);
  await assert.rejects(
    installer.install({ endpointHost: 'vpn.example.com', wanInterface: 'eth0' }),
    /already initialized/,
  );
  assert.equal(generated, false);
  assert.equal(fixture.getSaved(), undefined);
});

test('generates passwords without ambiguous characters', () => {
  const password = generatePassword({ length: 24, randomInt: () => 0 });
  assert.equal(password, PASSWORD_ALPHABET[0].repeat(24));
  assert.equal(/[0O1Il]/.test(PASSWORD_ALPHABET), false);
  assert.throws(() => generatePassword({ length: 15 }), /between 16 and 128/);
});
