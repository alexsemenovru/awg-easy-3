'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildClientRoutes } = require('../lib/ClientRoutes');

test('builds IPv4-only full tunnel when server IPv6 is unavailable', () => {
  assert.deepEqual(buildClientRoutes(), {
    allowedIps: ['0.0.0.0/0'],
    ipv6Policy: 'unavailable',
  });
});

test('builds a dual-stack full tunnel when server IPv6 is available', () => {
  assert.deepEqual(buildClientRoutes({ serverHasIPv6: true }), {
    allowedIps: ['0.0.0.0/0', '::/0'],
    ipv6Policy: 'tunnel',
  });
});
