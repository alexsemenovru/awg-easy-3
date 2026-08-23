'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');

test('pins amd64 base images and official AWG source revisions', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.equal((dockerfile.match(/FROM --platform=linux\/amd64/g) || []).length, 4);
  assert.equal((dockerfile.match(/@sha256:[a-f0-9]{64}/g) || []).length, 4);
  assert.match(dockerfile, /AWG_GO_COMMIT=1b86b2ae0e493e7ea93f8c1a0f0cb6735b1551f1/);
  assert.match(dockerfile, /AWG_TOOLS_COMMIT=ee0f0a9aa34ff0a0da4b3433b9512781cfe02843/);
  assert.doesNotMatch(dockerfile, /:latest/);
  assert.match(compose, /network_mode: host/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /AWG_LANG: \$\{AWG_LANG:-en\}/);
  assert.match(dockerfile, /\$\{AWG_PANEL_PORT\}/);
  assert.doesNotMatch(compose, /SYS_MODULE|ports:/);
});

test('installs only the minimal Node runtime dependency set', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'src', 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ['bcryptjs', 'qrcode']);
  assert.equal(packageJson.devDependencies, undefined);
});

test('installer initializes before startup and never publishes the panel port', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(installer, /x86_64\|amd64/);
  assert.match(installer, /docker compose run[\s\S]*awg-easy init/);
  assert.match(installer, /docker compose up -d awg-easy/);
  assert.ok(installer.indexOf(' awg-easy init') < installer.indexOf('docker compose up -d'));
  assert.match(installer, /http:\/\/10\.8\.0\.1:%s/);
  assert.doesNotMatch(installer, /51821:51821/);
});

test('installer rejects network conflicts before changing host settings', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const forwarding = installer.indexOf('Enabling IPv4/IPv6 forwarding');
  for (const preflight of [
    'ip link show dev awg0',
    'ip -4 route show exact 10.8.0.0/24',
    'ss -H -lun "sport = :$AWG_PORT_VALUE"',
    'ss -H -ltn "sport = :$AWG_PANEL_PORT_VALUE"',
  ]) {
    assert.match(installer, new RegExp(preflight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(installer.indexOf(preflight) < forwarding);
  }
});

test('installer accepts validated AWG port, panel port and language options', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(installer, /--port/);
  assert.match(installer, /--panel-port/);
  assert.match(installer, /--lang/);
  assert.match(installer, /en\|ru\|fa/);
  assert.match(installer, /valid_port/);
});
