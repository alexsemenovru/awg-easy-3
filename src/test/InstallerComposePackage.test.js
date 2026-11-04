'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../../install.sh'), 'utf8');
const fn = source.slice(source.indexOf('apt_compose_package() {'), source.indexOf('install_runtime_dependencies() {'));
const shell = process.env.AWG_TEST_SHELL || (process.platform === 'win32' ? null : 'sh');
test('APT accepts Debian docker-compose v2 but rejects a v1 or missing candidate',
  { skip: !shell && 'POSIX shell required' }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-apt-compose-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'apt-cache'), '#!/bin/sh\n[ "$1" = policy ] || exit 1\nprintf "  Candidate: %s\\n" "$CANDIDATE"\n', { mode: 0o755 });
    const posix = dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
    for (const [candidate, accepted] of [['2.26.1-4', true], ['1:2.26.1-4', true], ['1.29.2-1', false], ['(none)', false]]) {
      const r = spawnSync(shell, ['-s'], { input: `PATH='${posix}':$PATH\n${fn}\napt_compose_package\n`,
        encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, CANDIDATE: candidate } });
      assert.equal(r.status === 0, accepted, candidate + ': ' + r.stderr);
      assert.equal(r.stdout.trim(), accepted ? 'docker-compose' : '');
    }
  });
