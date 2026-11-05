'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const shell = process.env.AWG_TEST_SHELL || (process.platform === 'win32' ? null : 'sh');
const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'lib/discovery-port.sh'), 'utf8');
const posix = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const run = (body, file) => spawnSync(shell, ['-s'], { input: `${source}\n${body}`,
  encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, TASK_RECORD: posix(file) } });

test('installer reserves and remembers a DHT port without overlapping AWG, UDP sockets or Docker DNAT',
  { skip: !shell && 'POSIX shell required' }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-dht-port-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'record');
    fs.writeFileSync(file, 'AWG_IMAGE=sha256:fixture\n');
    const result = run(`
ss() { printf 'UNCONN 0 0 0.0.0.0:49034 0.0.0.0:*\\n'; }
docker() { if [ "$1" = ps ]; then printf abc123; else printf '49035/udp 49035\\n'; fi; }
awg_discovery_reserve_port "$TASK_RECORD" AWG_CELL_DHT_PORT 49033
ss() { exit 88; }
awg_discovery_reserve_port "$TASK_RECORD" AWG_CELL_DHT_PORT 49033
`, file);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), 'AWG_IMAGE=sha256:fixture\nAWG_CELL_DHT_PORT=49036\n');
  });

test('failed socket inspection leaves installation record unchanged',
  { skip: !shell && 'POSIX shell required' }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-dht-port-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'record');
    fs.writeFileSync(file, 'unchanged\n');
    const result = run('ss() { return 1; }\nawg_discovery_reserve_port "$TASK_RECORD" AWG_MAIN_DHT_PORT\n', file);
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged\n');
  });
