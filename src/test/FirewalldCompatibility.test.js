'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const helper = fs.readFileSync(path.join(__dirname, '../../lib/firewalld.sh'), 'utf8');
const shell = process.env.AWG_TEST_SHELL || (process.platform === 'win32' ? null : 'sh');
const opts = { skip: !shell && 'POSIX shell required' };
function run(t, args, env = {}, name = 'awg_easy_configure_firewalld') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-firewalld-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'firewall-cmd'), `#!/bin/sh
case "$1" in
 --state) exit "\${FW_STOPPED:-0}" ;;
 --get-zone-of-interface=wan0) echo public ;;
 --get-zone-of-interface=*) echo "\${FW_INTERFACE_ZONE:-no zone}" ;;
 --get-default-zone) echo public ;;
 *) printf '%s\\n' "$*" >> "$FW_LOG" ;;
esac
`, { mode: 0o755 });
  const posix = value => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
  const log = path.join(dir, 'calls');
  const r = spawnSync(shell, ['-s'], { input: `PATH='${posix(dir)}':$PATH\n` + helper + '\n'
    + name + ' ' + args + '\n', encoding: 'utf8', windowsHide: true,
    timeout: 10000, env: { ...process.env, FW_LOG: posix(log), ...env } });
  return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}
test('firewalld permits only reserved interfaces and UDP ports without a global reload', opts, t => {
  const r = run(t, 'wan0 "51830 53081" awgcellu0 awgdata0');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.trim().split('\n'), [
    '--permanent --zone=trusted --add-interface=awgcellu0 --add-interface=awgdata0',
    '--zone=trusted --add-interface=awgcellu0 --add-interface=awgdata0',
    '--permanent --zone=public --add-port=51830/udp --add-port=53081/udp',
    '--zone=public --add-port=51830/udp --add-port=53081/udp',
  ]);
});
test('firewalld refuses WAN reassignment and an existing foreign interface zone', opts, t => {
  for (const r of [run(t, 'wan0 "51830" wan0'),
    run(t, 'wan0 "51830" awgcellu0', { FW_INTERFACE_ZONE: 'public' }),
    run(t, 'wan0 "0" awgcellu0')]) {
    assert.notEqual(r.status, 0);
    assert.equal(r.calls, '');
  }
});
test('inactive firewalld needs no configuration changes', opts, t => {
  const r = run(t, 'wan0 "51830" awgcellu0', { FW_STOPPED: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls, '');
});

test('technical TCP relay opens only its reserved WAN port without reassigning interfaces', opts, t => {
  const result = run(t, 'wan0 49033', {}, 'awg_easy_configure_technical_firewalld');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.trim().split('\n'), [
    '--permanent --zone=public --add-port=49033/tcp', '--zone=public --add-port=49033/tcp',
  ]);
  for (const args of ['lo 49033', 'wan0 0', 'wan0 65536']) {
    const rejected = run(t, args, {}, 'awg_easy_configure_technical_firewalld');
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.calls, '');
  }
});
