'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertDistinctClientSubnets } = require('../lib/CellSubnetIsolation');

test('subnet reservations reject overlapping Main/Cell or Cell/Cell networks', () => {
  assert.equal(assertDistinctClientSubnets(['10.8.0.0/24', '10.64.0.0/24',
    'fd88::/64', 'fd99::/64']), true);
  assert.throws(() => assertDistinctClientSubnets(['10.8.0.0/24',
    '10.8.0.128/25']), /overlap/);
  assert.throws(() => assertDistinctClientSubnets(['10.64.0.1/24',
    '10.64.0.128/25']), /overlap/);
  assert.throws(() => assertDistinctClientSubnets(['fd88::/64',
    'fd88::100/120']), /overlap/);
});
