'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assignedSettingsFromState } = require('../lib/CellAssignedSettings');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const key = byte => Buffer.alloc(32, byte).toString('base64');
const cellId = 'a'.repeat(32);
const descriptor = () => ({ version: 1, endpointHost: 'cell.example.test', endpointPort: 51830,
  serverPublicKey: key(4), address4: '10.64.0.1', ipv4Subnet: '10.64.0.0/24',
  profile: generateOfficialProfile() });
const state = () => ({ version: 4, auth: { passwordHash: 'hash', sessionSecret: 'secret' },
  server: { interfaceName: 'awg0', wanInterface: 'eth0', privateKey: key(1),
    publicKey: key(2), address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24',
    endpointHost: 'main.example.test', listenPort: 51820, panelPort: 51821,
    profile: generateOfficialProfile() },
  clients: [
    { id: 'home-admin', name: 'Owner', networkGroup: 'home', enabled: true,
      address4: '10.8.0.2', privateKey: key(5), publicKey: key(6) },
    { id: 'friend', name: 'Friend', entryCellId: cellId, networkGroup: 'guest', enabled: true,
      address4: '10.64.0.2', privateKey: key(7), publicKey: key(8), presharedKey: key(9),
      geoPolicy: { mode: 'block', countries: ['RU'] } },
  ] });

test('Main compiles only the assigned public client view for each Cell', () => {
  const second = 'b'.repeat(32);
  const desired = assignedSettingsFromState(state(), [
    { id: cellId, descriptor: descriptor() }, { id: second, descriptor: null },
  ]);
  assert.deepEqual(Object.keys(desired), [cellId, second]);
  assert.equal(desired[cellId].clients.length, 1);
  assert.equal(desired[cellId].clients[0].id, 'friend');
  assert.equal(desired[cellId].clients[0].publicKey, key(8));
  assert.deepEqual(desired[cellId].clients[0].geoPolicy, { mode: 'block', countries: ['RU'] });
  assert.deepEqual(desired[second], { schema: 1, clients: [] });
  assert.equal(JSON.stringify(desired).includes(key(7)), false, 'client private key must not reach Cell');
  assert.equal(JSON.stringify(desired).includes('Friend'), false, 'client name must not reach Cell');
});

test('Main refuses unknown, unannounced or subnet-mismatched Cell assignments', () => {
  assert.throws(() => assignedSettingsFromState(state(), []), /not registered/);
  assert.throws(() => assignedSettingsFromState(state(), [{ id: cellId, descriptor: null }]),
    /not announced/);
  const other = descriptor();
  other.address4 = '10.65.0.1';
  other.ipv4Subnet = '10.65.0.0/24';
  assert.throws(() => assignedSettingsFromState(state(), [{ id: cellId, descriptor: other }]),
    /conflicts/);
});
