'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  allocateClientAddresses,
  allocateIPv4,
  allocateIPv6,
  formatIPv6,
  parseIPv6,
} = require('../lib/AddressAllocator');

test('allocates the first free IPv4 without using network, server or broadcast', () => {
  assert.equal(allocateIPv4({
    subnet: '10.8.0.0/29',
    serverAddress: '10.8.0.1',
    usedAddresses: ['10.8.0.2', '10.8.0.4'],
  }), '10.8.0.3');
  assert.throws(() => allocateIPv4({
    subnet: '10.8.0.0/30',
    serverAddress: '10.8.0.1',
    usedAddresses: ['10.8.0.2'],
  }), /No free client IPv4/);
});

test('parses, formats and allocates compressed IPv6 addresses', () => {
  assert.equal(formatIPv6(parseIPv6('fd42:8:3::abcd')), 'fd42:8:3::abcd');
  assert.equal(allocateIPv6({
    subnet: 'fd42:8:3::/124',
    serverAddress: 'fd42:8:3::1',
    usedAddresses: ['fd42:8:3::2'],
  }), 'fd42:8:3::3');
  assert.throws(() => parseIPv6('fd42:::1'), /Invalid IPv6/);
});

test('allocates dual-stack addresses together when server IPv6 is enabled', () => {
  assert.deepEqual(allocateClientAddresses({
    server: {
      ipv4Subnet: '10.8.0.0/24',
      address4: '10.8.0.1',
      ipv6Subnet: 'fd42:8:3::/64',
      address6: 'fd42:8:3::1',
    },
    clients: [{ address4: '10.8.0.2', address6: 'fd42:8:3::2' }],
  }), { address4: '10.8.0.3', address6: 'fd42:8:3::3' });
});
