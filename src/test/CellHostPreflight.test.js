'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertFreeCellHostResources } = require('../lib/CellHostPreflight');

const plan = () => ({ interfaceNames: ['awgctl0', 'awgjoin0'],
  udpPorts: [51822, 51823],
  nftTables: ['awg_easy_3_control', 'awg_easy_3_bootstrap'] });
function runner({ links = [{ ifname: 'lo' }, { ifname: 'eth0' }],
  sockets = 'UNCONN 0 0 0.0.0.0:51820 0.0.0.0:*\nUNCONN 0 0 [::]:53 [::]:*\n',
  tables = [{ metainfo: { version: '1.0' } },
    { table: { family: 'inet', name: 'unrelated' } }] } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (file === 'ip') return { stdout: JSON.stringify(links) };
    if (file === 'ss') return { stdout: sockets };
    if (file === 'nft') return { stdout: JSON.stringify({ nftables: tables }) };
    throw new Error('unexpected command');
  };
  return { run, calls };
}

test('new cell preflight reads host inventory without mutating it', async () => {
  const { run, calls } = runner();
  assert.deepEqual(await assertFreeCellHostResources({ ...plan(), runner: run }), { free: true });
  assert.deepEqual(calls.sort(), ['ip -j link show', 'nft -j list tables',
    'ss -H -u -l -n']);
});

test('new cell preflight refuses existing interfaces, UDP ports and nft tables', async () => {
  await assert.rejects(assertFreeCellHostResources({ ...plan(),
    runner: runner({ links: [{ ifname: 'awgctl0' }] }).run }),
  /interface already exists/);
  await assert.rejects(assertFreeCellHostResources({ ...plan(),
    runner: runner({ sockets: 'UNCONN 0 0 [::]:51822 [::]:*\n' }).run }),
  /UDP port already in use/);
  await assert.rejects(assertFreeCellHostResources({ ...plan(),
    runner: runner({ tables: [{ table: { family: 'inet', name: 'awg_easy_3_control' } }] }).run }),
  /nft table already exists/);
});

test('new cell preflight fails closed on malformed or ambiguous inventory', async () => {
  await assert.rejects(assertFreeCellHostResources({ ...plan(), udpPorts: [51822, 51822] }),
    /Invalid UDP port/);
  await assert.rejects(assertFreeCellHostResources({ ...plan(),
    runner: runner({ sockets: 'unknown format\n' }).run }), /Unrecognized UDP/);
  await assert.rejects(assertFreeCellHostResources({ ...plan(),
    runner: runner({ tables: [{ broken: true }] }).run }), /Invalid nft table inventory/);
});
