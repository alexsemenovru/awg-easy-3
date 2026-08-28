'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const cli = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');

const run = async (settings) => {
  let output = '';
  let error = '';
  const processStub = {
    argv: ['node', 'server.js', 'settings'], env: { AWG_PORT: '51820' },
    stdout: { write: (value) => { output += value; } },
    once: () => assert.fail('settings must not start the server'),
  };
  await vm.runInNewContext(cli, {
    require: (name) => {
      assert.equal(name, './lib/Application');
      return { Application: class { settings() { return settings(); } } };
    },
    process: processStub, console: { error: (value) => { error += value; } },
  });
  return { output, error, code: processStub.exitCode ?? 0 };
};

test('CLI settings uses persisted values instead of container initialization environment', async () => {
  const result = await run(async () => ({ AWG_HOST: 'vpn.example.com', AWG_PORT: 42123, AWG_PANEL_PORT: 8080, AWG_LANG: 'ru' }));
  assert.deepEqual(result, {
    output: 'AWG_HOST=vpn.example.com\nAWG_PORT=42123\nAWG_PANEL_PORT=8080\nAWG_LANG=ru\n', error: '', code: 0,
  });
});

test('CLI settings explains unavailable state and exits unsuccessfully', async () => {
  const result = await run(async () => { throw new Error('AWG-Easy 3 is not initialized'); });
  assert.deepEqual(result, { output: '', error: 'AWG-Easy 3 is not initialized', code: 1 });
});

test('manager settings reads a one-shot container without starting the VPN', () => {
  const manager = fs.readFileSync(path.join(__dirname, '..', '..', 'awg-easy-3'), 'utf8');
  const command = manager.slice(manager.indexOf('  settings)'), manager.indexOf('  logs)'));
  assert.match(command, /compose run --rm --no-deps -T awg-easy settings/);
  assert.doesNotMatch(command, /\.Config\.Env|up -d|restart|\binit\b/);
});
