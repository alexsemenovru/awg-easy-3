'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildClientRoutes, excludeIPv4Cidrs } = require('../lib/ClientRoutes');

test('builds IPv4-only full tunnel when server IPv6 is unavailable', () => {
  assert.deepEqual(buildClientRoutes({ mode: 'vpn_all' }), {
    allowedIps: ['0.0.0.0/0'],
    ipv6Policy: 'unavailable',
  });
});

test('builds a dual-stack full tunnel when server IPv6 is available', () => {
  assert.deepEqual(buildClientRoutes({ mode: 'vpn_all', serverHasIPv6: true }), {
    allowedIps: ['0.0.0.0/0', '::/0'],
    ipv6Policy: 'tunnel',
  });
});

test('computes the exact complement of excluded IPv4 networks', () => {
  assert.deepEqual(excludeIPv4Cidrs(['0.0.0.0/1']), ['128.0.0.0/1']);
  assert.deepEqual(excludeIPv4Cidrs(['128.0.0.0/1']), ['0.0.0.0/1']);
  assert.deepEqual(excludeIPv4Cidrs(['10.0.0.0/8', '10.0.0.0/9']), [
    '0.0.0.0/5',
    '8.0.0.0/7',
    '11.0.0.0/8',
    '12.0.0.0/6',
    '16.0.0.0/4',
    '32.0.0.0/3',
    '64.0.0.0/2',
    '128.0.0.0/1',
  ]);
});

test('captures and blocks IPv6 in RU-direct mode', () => {
  const routes = buildClientRoutes({ mode: 'ru_direct', ruIPv4Cidrs: ['5.136.0.0/13'] });
  assert.equal(routes.ipv6Policy, 'block');
  assert.equal(routes.allowedIps.at(-1), '::/0');
  assert.ok(!routes.allowedIps.includes('0.0.0.0/0'));
});

test('rejects an empty GeoIP list instead of silently tunnelling RU traffic', () => {
  assert.throws(
    () => buildClientRoutes({ mode: 'ru_direct', ruIPv4Cidrs: [] }),
    /At least one excluded/,
  );
});

