'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DEFAULT_DNS, buildDnsPolicy, renderDnsLine } = require('../lib/DnsPolicy');

test('uses the requested AdGuard IPv4 defaults', () => {
  assert.deepEqual(DEFAULT_DNS.ipv4, ['94.140.14.14', '94.140.15.15']);
  assert.deepEqual(buildDnsPolicy().servers, DEFAULT_DNS.ipv4);
});

test('adds the requested AdGuard IPv6 defaults only to a capable full tunnel', () => {
  const policy = buildDnsPolicy({ serverHasIPv6: true });
  assert.deepEqual(policy.servers, [
    '94.140.14.14',
    '94.140.15.15',
    '2a10:50c0::ad1:ff',
    '2a10:50c0::ad2:ff',
  ]);
  assert.deepEqual(policy.amneziaDns, DEFAULT_DNS.ipv4);
});

test('validates custom DNS addresses by family', () => {
  assert.throws(
    () => buildDnsPolicy({
      ipv4: ['1.1.1.1', 'not-an-ip'],
    }),
    /invalid IPv4/,
  );
});
