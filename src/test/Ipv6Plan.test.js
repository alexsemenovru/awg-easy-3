'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createNat66Plan } = require('../lib/Ipv6Plan');

test('creates a stable private /64 for automatic NAT66', () => {
  const plan = createNat66Plan({ randomBytes: () => Buffer.from([0xab, 0xcd, 0xef, 0x12, 0x34]) });
  assert.deepEqual(plan, {
    mode: 'nat66',
    subnet: 'fdab:cdef:1234::/64',
    serverAddress: 'fdab:cdef:1234::1',
    firstClientAddress: 'fdab:cdef:1234::2',
  });
});

test('requires exactly forty random global-ID bits', () => {
  assert.throws(() => createNat66Plan({ randomBytes: () => Buffer.alloc(4) }), /exactly five bytes/);
});
