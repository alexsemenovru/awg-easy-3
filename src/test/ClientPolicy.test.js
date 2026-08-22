'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { assertActiveHomeRemains, normalizeClientPolicy } = require('../lib/ClientPolicy');

test('makes the bootstrap peer home and later peers guest by default', () => {
  assert.deepEqual(normalizeClientPolicy({}, { bootstrap: true }), {
    networkGroup: 'home',
    routeMode: 'vpn_all',
  });
  assert.deepEqual(normalizeClientPolicy(), {
    networkGroup: 'guest',
    routeMode: 'vpn_all',
  });
});

test('accepts explicit home and RU-direct policy', () => {
  assert.deepEqual(normalizeClientPolicy({ networkGroup: 'home', routeMode: 'ru_direct' }), {
    networkGroup: 'home',
    routeMode: 'ru_direct',
  });
});

test('prevents demoting, disabling or deleting the last active home peer', () => {
  const clients = [{ id: 'admin', networkGroup: 'home', enabled: true }];
  assert.throws(() => assertActiveHomeRemains(clients, 'admin', { networkGroup: 'guest' }), /home client/);
  assert.throws(() => assertActiveHomeRemains(clients, 'admin', { enabled: false }), /home client/);
  assert.throws(() => assertActiveHomeRemains(clients, 'admin', { deleted: true }), /home client/);
});

test('allows changes when another active home peer remains', () => {
  const clients = [
    { id: 'admin', networkGroup: 'home', enabled: true },
    { id: 'phone', networkGroup: 'home', enabled: true },
    { id: 'guest', networkGroup: 'guest', enabled: true },
  ];
  assert.doesNotThrow(() => assertActiveHomeRemains(clients, 'admin', { enabled: false }));
  assert.doesNotThrow(() => assertActiveHomeRemains(clients, 'guest', { routeMode: 'ru_direct' }));
});

test('rejects unknown policy values', () => {
  assert.throws(() => normalizeClientPolicy({ networkGroup: 'friends' }), /networkGroup/);
  assert.throws(() => normalizeClientPolicy({ routeMode: 'direct_all' }), /routeMode/);
});

