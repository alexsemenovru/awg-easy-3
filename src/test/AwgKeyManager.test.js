'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { AwgKeyManager, validateKey } = require('../lib/AwgKeyManager');

const PRIVATE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const PUBLIC_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const PRESHARED_KEY = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';

test('generates a key pair without putting the private key in argv', async () => {
  const calls = [];
  const manager = new AwgKeyManager({
    binary: '/usr/bin/awg',
    runner: async (file, args, options = {}) => {
      calls.push({ file, args, options });
      return { stdout: args[0] === 'genkey' ? PRIVATE_KEY : PUBLIC_KEY, stderr: '' };
    },
  });

  assert.deepEqual(await manager.generateKeyPair(), {
    privateKey: PRIVATE_KEY,
    publicKey: PUBLIC_KEY,
  });
  assert.deepEqual(calls[1].args, ['pubkey']);
  assert.equal(calls[1].options.input, `${PRIVATE_KEY}\n`);
  assert.equal(calls[1].args.includes(PRIVATE_KEY), false);
});

test('generates complete peer key material', async () => {
  const outputs = [PRIVATE_KEY, PUBLIC_KEY, PRESHARED_KEY];
  const commands = [];
  const manager = new AwgKeyManager({
    runner: async (file, args) => {
      commands.push(args[0]);
      return { stdout: outputs.shift(), stderr: '' };
    },
  });

  assert.deepEqual(await manager.generatePeerKeys(), {
    privateKey: PRIVATE_KEY,
    publicKey: PUBLIC_KEY,
    presharedKey: PRESHARED_KEY,
  });
  assert.deepEqual(commands, ['genkey', 'pubkey', 'genpsk']);
});

test('rejects malformed key output and input', async () => {
  assert.throws(() => validateKey('not-a-key', 'test'), /invalid WireGuard key/);
  const manager = new AwgKeyManager({
    runner: async () => ({ stdout: 'unexpected diagnostic output', stderr: '' }),
  });
  await assert.rejects(manager.generatePrivateKey(), /invalid WireGuard key/);
  await assert.rejects(manager.derivePublicKey('bad'), /invalid WireGuard key/);
});
