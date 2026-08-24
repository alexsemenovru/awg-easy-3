'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DiscoveryRelay, SERVICES, rewriteSsdpLocation,
} = require('../lib/DiscoveryRelay');

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

test('rewrites SSDP location hosts to the advertising Home peer address', () => {
  const message = Buffer.from([
    'NOTIFY * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'LOCATION: http://192.168.1.18:9080/device.xml',
    'AL: http://[fe80::1]:9080/alternate.xml',
    '',
    'body',
  ].join('\r\n'));
  const rewritten = rewriteSsdpLocation(message, '10.8.0.2').toString('utf8');
  assert.match(rewritten, /LOCATION: http:\/\/10\.8\.0\.2:9080\/device\.xml/);
  assert.match(rewritten, /AL: http:\/\/10\.8\.0\.2:9080\/alternate\.xml/);
  assert.match(rewritten, /\r\n\r\nbody$/);
});

test('leaves SSDP searches and mDNS-compatible binary payloads unchanged', () => {
  const search = Buffer.from('M-SEARCH * HTTP/1.1\r\nST: ssdp:all\r\n\r\n');
  assert.equal(rewriteSsdpLocation(search, '10.8.0.3'), search);
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
