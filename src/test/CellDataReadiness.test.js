'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifiedCellDataLink } = require('../lib/CellDataReadiness');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { routingPolicySnapshot } = require('../lib/CellNftPolicyJson');

const key = Buffer.alloc(32, 4).toString('base64');
const descriptor = { version: 1, slot: 0, endpointHost: '198.51.100.4',
  endpointPort: 53000, controllerAddress4: '10.252.0.1', cellAddress4: '10.252.0.2',
  controllerPublicKey: key, controllerClientSubnet4: '10.8.0.0/24',
  cellClientSubnet4: '10.88.0.0/24', profile: generateOfficialProfile() };
const routingSpec = { version: 1, interfaces: ['awg0', 'awgd0'], commands: [],
  nftSnapshot: routingPolicySnapshot({ input: [], forward: [], output: [],
    nat: [], sets: [] }) };

test('readiness requires both unguarded exact route and a fresh authenticated handshake', async () => {
  const cellId = 'a'.repeat(32), events = [];
  let pathReady = false, routeReady = false, handshake = false;
  const input = { cellId, descriptor, routingSpec,
    dataPath: { interfaceName: 'awgd0', verifyOperational: async () => pathReady },
    routing: { verifyOperational: async () => routeReady },
    verifyHandshake: async () => { events.push('handshake'); return handshake; } };
  assert.equal(await verifiedCellDataLink(input), null);
  pathReady = true;
  assert.equal(await verifiedCellDataLink(input), null);
  routeReady = true;
  assert.equal(await verifiedCellDataLink(input), null);
  handshake = true;
  assert.deepEqual(await verifiedCellDataLink(input), { cellId, ipv4: true, ipv6: false });
  assert.equal(events.length, 2);
  routeReady = false;
  assert.equal(await verifiedCellDataLink(input), null);
  await assert.rejects(verifiedCellDataLink({ ...input,
    dataPath: { ...input.dataPath, interfaceName: 'wrong' } }), /omits/);
});
