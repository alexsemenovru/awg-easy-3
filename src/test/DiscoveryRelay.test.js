'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DiscoveryRelay, SERVICES } = require('../lib/DiscoveryRelay');

const state = () => ({
  server: { address4: '10.8.0.1', interfaceName: 'awg0' },
  clients: [
    { id: 'a', enabled: true, networkGroup: 'home', address4: '10.8.0.2' },
    { id: 'b', enabled: true, networkGroup: 'home', address4: '10.8.0.3' },
    { id: 'g', enabled: true, networkGroup: 'guest', address4: '10.8.0.4' },
    { id: 'off', enabled: false, networkGroup: 'home', address4: '10.8.0.5' },
  ],
});

test('fans mDNS only between enabled Home peers', () => {
  const relay = new DiscoveryRelay();
  relay.refresh(state());
  const mdns = SERVICES.find((service) => service.name === 'mdns4');
  assert.deepEqual(relay.targets(mdns, { address: '10.8.0.2', port: 5353 }), [
    { address: '10.8.0.3', port: 5353 },
  ]);
  assert.deepEqual(relay.targets(mdns, { address: '10.8.0.4', port: 5353 }), []);
});

test('returns SSDP responses to recent requester ports without involving Guests', () => {
  let now = 1000;
  const relay = new DiscoveryRelay({ clock: () => now });
  relay.refresh(state());
  const ssdp = SERVICES.find((service) => service.name === 'ssdp4');
  assert.deepEqual(relay.targets(ssdp, { address: '10.8.0.2', port: 43123 }), [
    { address: '10.8.0.3', port: 1900 },
  ]);
  assert.deepEqual(relay.targets(ssdp, { address: '10.8.0.3', port: 1900 }), [
    { address: '10.8.0.2', port: 1900 },
    { address: '10.8.0.2', port: 43123 },
  ]);
  now += 16_000;
  assert.deepEqual(relay.targets(ssdp, { address: '10.8.0.3', port: 1900 }), [
    { address: '10.8.0.2', port: 1900 },
  ]);
});

test('uses IPv4 discovery even when the VPN is dual-stack', () => {
  assert.ok(SERVICES.length > 0);
  assert.ok(SERVICES.every((service) => service.family === 'udp4'));
});

test('closes a bound socket when multicast membership fails', async () => {
  let closed = false;
  const socket = {
    on: () => {},
    once: () => {},
    off: () => {},
    bind: (_port, _host, callback) => callback(),
    addMembership: () => { throw new Error('membership failed'); },
    close: (callback) => { closed = true; callback(); },
  };
  const relay = new DiscoveryRelay({ socketFactory: () => socket });

  await assert.rejects(relay.start(state()), /membership failed/);
  assert.equal(closed, true);
  assert.equal(relay.sockets.length, 0);
});
