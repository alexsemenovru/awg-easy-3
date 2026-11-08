'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createNat66Plan } = require('../lib/Ipv6Plan');

test('new installations share the fixed Main panel address and private /64', () => {
  const plan = createNat66Plan();
  assert.deepEqual(plan, {
    mode: 'nat66',
    subnet: 'fd08:8::/64',
    serverAddress: 'fd08:8::1',
    firstClientAddress: 'fd08:8::2',
  });
});

test('generating another installation cannot mutate the shared defaults', () => {
  const first = createNat66Plan();
  assert.throws(() => { first.serverAddress = 'fd99::1'; }, TypeError);
  assert.deepEqual(createNat66Plan(), first);
});
