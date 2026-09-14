'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { CellRuntimeAdapter, guardPolicy } = require('../lib/CellRuntimeAdapter');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const server = () => ({ interfaceName: 'awg0', wanInterface: 'eth0', privateKey: Buffer.alloc(32, 1).toString('base64'),
  listenPort: 12345, address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24', profile: generateOfficialProfile() });

test('cell runtime blocks traffic before changing peers and unblocks only on success', async () => {
  const calls = [];
  const runner = async (file, args, opts) => {
    calls.push([file, ...args].join(' '));
    if (args[0] === 'list' || file === 'ip') throw Object.assign(new Error('missing'), { code: 1 });
    if (opts?.input) assert.match(opts.input, /priority -20/);
    return { stdout: '' };
  };
  const adapter = new CellRuntimeAdapter({ server: server(), runner, runtime: { apply: async value => {
    calls.push('apply'); assert.equal(value.interfaceActive, false);
  } } });
  await adapter.apply({ schema: 1, clients: [] });
  assert.ok(calls.indexOf('nft -f -') < calls.indexOf('apply'));
  assert.equal(calls.at(-1), 'nft delete table inet awg_easy_3_cell_guard');
});

test('runtime failure retains guard; validation failure touches no system objects', async () => {
  const calls = [];
  const adapter = new CellRuntimeAdapter({ server: server(), runner: async (file, args) => {
    calls.push([file, ...args].join(' ')); return { stdout: '' };
  }, runtime: { runtimeDirectory: '/cell-test', readOptional: async () => '[Interface]',
    apply: async () => { throw new Error('apply failed'); } } });
  await assert.rejects(adapter.apply({ shell: 'anything' }));
  assert.equal(calls.length, 0);
  await assert.rejects(adapter.apply({ schema: 1, clients: [] }), /apply failed/);
  assert.ok(!calls.some(call => call.startsWith('nft delete')));
});

test('guard syntax validates in isolated Linux namespace', { skip: process.env.AWG_TEST_WSL !== '1' }, () => {
  const result = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'unshare', '-n', 'nft', '-c', '-f', '-'],
    { input: guardPolicy('awg0'), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
});
