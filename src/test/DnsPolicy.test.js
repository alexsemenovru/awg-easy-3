'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DEFAULT_DNS, buildDnsPolicy, renderDnsLine } = require('../lib/DnsPolicy');

test('uses the requested AdGuard IPv4 defaults in every route mode', () => {
  assert.deepEqual(DEFAULT_DNS.ipv4, ['94.140.14.14', '94.140.15.15']);
  assert.deepEqual(buildDnsPolicy({ routeMode: 'ru_direct' }).servers, DEFAULT_DNS.ipv4);
  assert.deepEqual(buildDnsPolicy({ routeMode: 'vpn_all' }).servers, DEFAULT_DNS.ipv4);
});

test('adds the requested AdGuard IPv6 defaults only to a capable full tunnel', () => {
  const policy = buildDnsPolicy({ routeMode: 'vpn_all', serverHasIPv6: true });
  assert.deepEqual(policy.servers, [
    '94.140.14.14',
    '94.140.15.15',
    '2a10:50c0::ad1:ff',
    '2a10:50c0::ad2:ff',
  ]);
  assert.deepEqual(policy.amneziaDns, DEFAULT_DNS.ipv4);
});

test('does not advertise unreachable IPv6 DNS in RU-direct mode', () => {
  const policy = buildDnsPolicy({ routeMode: 'ru_direct', serverHasIPv6: true });
  assert.deepEqual(policy.servers, DEFAULT_DNS.ipv4);
  assert.equal(renderDnsLine(policy), 'DNS = 94.140.14.14, 94.140.15.15');
});

test('validates custom DNS addresses by family', () => {
  assert.throws(
    () => buildDnsPolicy({
      routeMode: 'vpn_all',
      ipv4: ['1.1.1.1', 'not-an-ip'],
    }),
    /invalid IPv4/,
  );
});

