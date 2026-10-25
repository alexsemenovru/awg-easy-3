'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderServerConfig } = require('../lib/AwgConfigRenderer');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { verifyMainUserTunnel } = require('../lib/MainUserTunnelVerifier');

const key = n => Buffer.alloc(32, n).toString('base64');
const state = { server: { interfaceName: 'awg0', privateKey: key(1),
  address4: '10.8.0.1', listenPort: 51820, profile: generateOfficialProfile() },
clients: [{ id: 'home', name: 'Home', enabled: true,
  address4: '10.8.0.2', publicKey: key(2) },
{ id: 'remote', name: 'Remote', enabled: true, entryCellId: 'a'.repeat(32),
  address4: '10.88.0.2', publicKey: key(3) }] };

test('Main verifies only its own live peers, endpoint and panel address', async () => {
  const actual = renderServerConfig({ privateKey: state.server.privateKey,
    addresses: ['10.8.0.1/24'], listenPort: 51820,
    profile: state.server.profile,
    peers: [{ name: 'Home', publicKey: key(2), allowedIps: ['10.8.0.2/32'] }] })
    .split('\n').filter(line => !line.startsWith('Address = ')).join('\n');
  const addr = JSON.stringify([{ ifname: 'awg0', addr_info: [
    { family: 'inet', local: '10.8.0.1', prefixlen: 24 }] }]);
  const runner = async (file, args) => file === 'awg'
    ? { stdout: actual } : { stdout: addr };
  assert.equal(await verifyMainUserTunnel(state, { runner }), true);
  assert.equal(await verifyMainUserTunnel(state, { runner: async (file, args) =>
    file === 'awg' ? { stdout: actual.replace(key(2), key(4)) } : { stdout: addr } }), false);
  assert.equal(await verifyMainUserTunnel(state, { runner: async file =>
    file === 'awg' ? { stdout: actual } : { stdout: addr.replace('10.8.0.1', '10.8.0.9') } }), false);
});
