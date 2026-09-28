'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { specification } = require('../lib/CellAwgLifecycle');
const { inspectBootstrapConflicts, prepareBootstrapDevice } = require('../lib/CellAwgBootstrapDevice');

const base = { interfaceName: 'awg-enroll', listenPort: 51824,
  controllerAddress: '10.90.0.1', privateKey: crypto.randomBytes(32).toString('base64'),
  profile: generateOfficialProfile(), userInterfaces: ['awg3'], userUdpPorts: [51820] };
function inventory({ names = ['lo', 'awg3'], sockets = 'UNCONN 0 0 0.0.0.0:51820 0.0.0.0:*\n' } = {}) {
  const calls = [];
  return { calls, runner: async (program, args) => {
    calls.push([program, args]);
    if (program === 'ip') return { stdout: JSON.stringify(names.map(ifname => ({ ifname }))) };
    if (program === 'ss') return { stdout: sockets };
    throw new Error('Unexpected process');
  } };
}

test('dedicated bootstrap device is distinct from user AWG and has only its local address', async () => {
  const host = inventory();
  const prepared = await prepareBootstrapDevice({ ...base, runner: host.runner });
  assert.deepEqual(specification(prepared), prepared);
  assert.equal(prepared.owner.interfaceName, 'awg-enroll');
  assert.deepEqual(prepared.addresses, ['10.90.0.1/32']);
  assert.match(prepared.owner.config, /ListenPort = 51824/);
  assert.doesNotMatch(prepared.owner.config, /\[Peer\]/);
  assert.deepEqual(host.calls.map(call => call[0]), ['ip', 'ss']);
});

test('preflight rejects overlap with declared or actual user/network state', async () => {
  const host = inventory();
  await assert.rejects(prepareBootstrapDevice({ ...base, interfaceName: 'awg3', runner: host.runner }), /overlaps/);
  await assert.rejects(prepareBootstrapDevice({ ...base, listenPort: 51820, runner: host.runner }), /overlaps/);
  assert.equal(host.calls.length, 0);
  await assert.rejects(prepareBootstrapDevice({ ...base, runner: inventory({ names: ['awg-enroll'] }).runner }), /already exists/);
  await assert.rejects(prepareBootstrapDevice({ ...base, runner: inventory({ sockets:
    'UNCONN 0 0 [::]:51824 [::]:*\n' }).runner }), /already in use/);
  await assert.rejects(prepareBootstrapDevice({ ...base, runner: inventory({ sockets:
    'ESTAB 0 0 192.0.2.1:51824 198.51.100.1:9999\n' }).runner }), /already in use/);
});

test('unreadable or malformed host inventory is a hard failure', async () => {
  await assert.rejects(inspectBootstrapConflicts({ ...base, runner: async () => { throw new Error('ss denied'); } }),
    /inventory unavailable/);
  await assert.rejects(inspectBootstrapConflicts({ ...base, runner: inventory({ sockets:
    'not an ss row\n' }).runner }), /Invalid UDP socket inventory/);
  await assert.rejects(inspectBootstrapConflicts({ ...base, runner: inventory({ names: ['lo'], sockets:
    'UNCONN 0 0 *:foo *:*\n' }).runner }), /Invalid UDP socket inventory/);
});

test('IPv6 bootstrap address is host-scoped and follows the same collision checks', async () => {
  const prepared = await prepareBootstrapDevice({ ...base, controllerAddress: 'fd35:e03:5563::1',
    runner: inventory({ sockets: 'UNCONN 0 0 [::]:22 [::]:*\n' }).runner });
  assert.deepEqual(prepared.addresses, ['fd35:e03:5563::1/128']);
});
