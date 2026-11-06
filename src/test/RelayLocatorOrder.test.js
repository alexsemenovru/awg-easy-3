'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { relayLocatorOrder } = require('../lib/RelayLocatorOrder');
test('unpublished recovery aliases cannot starve the live authority across relay retries', () => {
  const peer = { publicKey: 'historical', lookupKeys: ['recovery', 'live', 'historical'] };
  assert.deepEqual([0, 1, 2].map(attempt => relayLocatorOrder(peer, [], attempt)[0]),
    ['recovery', 'live', 'historical']);
  assert.deepEqual(relayLocatorOrder(peer, [{ lookupKey: 'live' }], 1), ['live', 'historical', 'recovery']);
  assert.deepEqual(relayLocatorOrder(peer, [{ lookupKey: 'foreign' }], 0), peer.lookupKeys);
  assert.deepEqual(relayLocatorOrder({ publicKey: 'historical' }, [], 2), ['historical']);
});
