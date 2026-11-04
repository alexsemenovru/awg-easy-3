'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const helper = fs.readFileSync(path.join(__dirname, '../../lib/selinux-socket-watch.sh'), 'utf8');
const shell = process.env.AWG_TEST_SHELL || (process.platform === 'win32' ? null : 'sh');
const options = { skip: !shell && 'POSIX shell required' };
function run(body) {
  return spawnSync(shell, ['-s'], { input: helper + '\n' + body,
    encoding: 'utf8', timeout: 10000, windowsHide: true });
}
test('disabled SELinux does not install a policy', options, () => {
  const result = run('getenforce() { echo Disabled; }; semodule() { exit 91; }; awg_easy_install_selinux_socket_watch');
  assert.equal(result.status, 0, result.stderr);
});
test('SELinux compatibility grants only socket watch and keeps enforcement', options, () => {
  const result = run(`
    getenforce() { echo Enforcing; }
    semodule() { [ "$1" = -i ] || return 92; cat "$2"; }
    awg_easy_install_selinux_socket_watch
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '(allow container_t container_file_t (sock_file (watch)))');
});
test('a rejected SELinux policy fails the installation', options, () => {
  const result = run('getenforce() { echo Enforcing; }; semodule() { return 73; }; awg_easy_install_selinux_socket_watch');
  assert.equal(result.status, 73, result.stderr);
});
