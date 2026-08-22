'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { NetworkDetector, selectDefaultRoute } = require('../lib/NetworkDetector');

const runnerFor = (responses, calls = []) => async (file, args) => {
  calls.push({ file, args });
  const key = args.join(' ');
  if (!(key in responses)) throw new Error(`Unexpected command: ${key}`);
  return { stdout: JSON.stringify(responses[key]), stderr: '' };
};

test('detects the lowest-metric WAN and working global IPv6', async () => {
  const calls = [];
  const detector = new NetworkDetector({ runner: runnerFor({
    '-j -4 route show default': [
      { dst: 'default', gateway: '192.0.2.1', dev: 'ens4', metric: 200 },
      { dst: 'default', gateway: '198.51.100.1', dev: 'ens3', metric: 100 },
    ],
    '-j -4 addr show dev ens3': [{ addr_info: [
      { family: 'inet', local: '198.51.100.20', prefixlen: 24, scope: 'global' },
    ] }],
    '-j -6 route show default': [{ dst: 'default', gateway: '2001:db8::1', dev: 'ens3' }],
    '-j -6 addr show dev ens3': [{ addr_info: [
      { family: 'inet6', local: '2001:db8::20', prefixlen: 64, scope: 'global', flags: ['permanent'] },
      { family: 'inet6', local: '2001:db8::21', prefixlen: 64, scope: 'global', flags: ['tentative'] },
      { family: 'inet6', local: 'fe80::1', prefixlen: 64, scope: 'link' },
    ] }],
  }, calls) });

  const result = await detector.detect();
  assert.equal(result.wanInterface, 'ens3');
  assert.equal(result.endpointCandidate, '198.51.100.20');
  assert.equal(result.ipv6.available, true);
  assert.deepEqual(result.ipv6.addresses, [{ address: '2001:db8::20', prefixLength: 64 }]);
  assert.equal(calls.every((call) => call.file === 'ip'), true);
});

test('keeps IPv6 disabled when its default route uses another interface', async () => {
  const calls = [];
  const detector = new NetworkDetector({ runner: runnerFor({
    '-j -4 route show default': [{ dst: 'default', dev: 'eth0' }],
    '-j -4 addr show dev eth0': [{ addr_info: [
      { family: 'inet', local: '203.0.113.10', prefixlen: 24, scope: 'global' },
    ] }],
    '-j -6 route show default': [{ dst: 'default', dev: 'eth1' }],
  }, calls) });

  const result = await detector.detect();
  assert.equal(result.ipv6.available, false);
  assert.equal(calls.some((call) => call.args.includes('addr') && call.args.includes('-6')), false);
});

test('rejects missing routes, malformed JSON and unsafe interface names', async () => {
  const noRoute = new NetworkDetector({ runner: runnerFor({
    '-j -4 route show default': [],
  }) });
  await assert.rejects(noRoute.detect(), /No usable IPv4 default route/);

  const malformed = new NetworkDetector({ runner: async () => ({ stdout: '{bad', stderr: '' }) });
  await assert.rejects(malformed.detect(), /valid JSON/);

  assert.throws(
    () => selectDefaultRoute([{ dst: 'default', dev: 'eth0\nmalicious' }], 4),
    /Invalid Linux interface/,
  );
});
