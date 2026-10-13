'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const installer = fs.readFileSync(path.join(__dirname, '..', '..', 'install.sh'), 'utf8').replace(/\r\n/g, '\n');
const definitions = installer.slice(0, installer.indexOf('\nAWG_PORT_VALUE=${AWG_PORT-}'));
const shell = process.env.AWG_TEST_SHELL || (process.platform === 'win32' ? null : 'sh');
const shellOptions = { skip: !shell && 'Set AWG_TEST_SHELL to a POSIX sh executable on Windows' };
const run = (body) => spawnSync(shell, ['-s'], {
  input: `${definitions}\nAWG_HOST_VALUE=\n${body}\n`, encoding: 'utf8', timeout: 10_000,
  env: { ...process.env, PATH: process.platform === 'win32' ? `${path.dirname(shell)};${process.env.PATH}` : process.env.PATH }, windowsHide: true,
});

test('installer accepts only plausible public detected IPv4 addresses', shellOptions, () => {
  const result = run(`
    is_public_ipv4 8.8.8.8
    ! is_public_ipv4 10.0.0.1
    ! is_public_ipv4 100.64.0.1
    ! is_public_ipv4 192.168.1.2
    ! is_public_ipv4 999.1.1.1
    valid_endpoint_host vpn.example.com
    ! valid_endpoint_host 'bad host'
    printf OK
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'OK');
});

test('interactive installer offers detected IP, alternate IP and domain', shellOptions, () => {
  for (const [selection, expected] of [['', '8.8.8.8'], ['2', '9.9.9.9'], ['3', 'vpn.example.com']]) {
    const answers = `${selection}\n${selection === '2' ? '9.9.9.9\n' : selection === '3' ? 'vpn.example.com\n' : ''}`;
    const result = run(`
      is_interactive() { return 0; }
      ip() { printf '1.1.1.1 via 8.8.8.1 dev eth0 src 8.8.8.8\\n'; }
      printf '%s' '${answers}' | { choose_endpoint_host; printf '%s' "$AWG_HOST_VALUE"; }
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});

test('noninteractive installer requires a public auto-detected IP or explicit host', shellOptions, () => {
  const result = run(`
    is_interactive() { return 1; }
    ip() { printf '1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.2\\n'; }
    choose_endpoint_host
  `);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /use --host/);
});
