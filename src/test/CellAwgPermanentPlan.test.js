'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { CellAwgPermanentPath } = require('../lib/CellAwgPermanentPath');
const { permanentCellPlan, permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');

const key = () => crypto.randomBytes(32).toString('base64');
function fixture() {
  const serverPublicKey = key();
  const descriptor = { version: 1, endpointHost: 'controller.example', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey, profile: generateOfficialProfile() };
  const connection = { status: 'registered', permanent: { privateKey: key(),
    presharedKey: key() }, controllerPath: descriptor };
  const peer = { cellAddress: descriptor.cellAddress, awgPublicKey: key(),
    awgPresharedKey: connection.permanent.presharedKey };
  return { descriptor, connection, peer, serverPrivateKey: key(),
    keyManager: { derivePublicKey: async () => serverPublicKey } };
}

test('cell plan combines signed descriptor, owned key, dedicated policy and host route', () => {
  const f = fixture();
  const first = permanentCellPlan({ connection: f.connection, interfaceName: 'awgperm8',
    resolvedEndpointHost: '203.0.113.25' });
  assert.equal(first.spec.addresses[0], '10.91.8.2/32');
  assert.equal(first.policy.nftables[0].table.name, 'awg_easy_3_control');
  assert.deepEqual(first.routeCommands[0].args,
    ['-4', 'route', 'add', '10.91.8.1/32', 'table', 'main', 'proto', '186', 'dev', 'awgperm8']);
  const recovered = permanentCellPlan({ connection: f.connection, interfaceName: 'awgperm8',
    resolvedEndpointHost: '203.0.113.25', owner: first.spec.owner });
  assert.deepEqual(recovered, first);
  assert.throws(() => permanentCellPlan({ connection: f.connection, interfaceName: 'awgperm8',
    resolvedEndpointHost: '203.0.113.26', owner: first.spec.owner }), /differs/);
  assert.throws(() => permanentCellPlan({ connection: f.connection, interfaceName: 'awgperm8' }), /Literal/);
});

test('controller plan requires signed peer and reuses only matching persisted identity', async () => {
  const f = fixture();
  const args = { privateKey: f.serverPrivateKey, descriptor: f.descriptor,
    peers: [f.peer], interfaceName: 'awgperm8', keyManager: f.keyManager };
  const first = await permanentControllerPlan(args);
  assert.equal(first.spec.addresses[0], '10.91.8.1/32');
  assert.equal(first.routeCommands[0].args[3], '10.91.8.2/32');
  assert.deepEqual(await permanentControllerPlan({ ...args, owner: first.spec.owner }), first);
  await assert.rejects(permanentControllerPlan({ ...args, peers: [] }), /absent/);
  await assert.rejects(permanentControllerPlan({ ...args, peers: [{ ...f.peer,
    awgPublicKey: key() }], owner: first.spec.owner }), /differs/);
});

test('generated plan has exact shape accepted by permanent path component', () => {
  const f = fixture();
  const plan = permanentCellPlan({ connection: f.connection, interfaceName: 'awgperm8',
    resolvedEndpointHost: '203.0.113.25' });
  const methods = names => Object.fromEntries(names.map(name => [name, async () => {}]));
  const path = new CellAwgPermanentPath({ ...plan,
    lifecycle: methods(['load', 'create', 'recover', 'verify']),
    awg: methods(['load', 'initialize', 'recover', 'inspect']),
    routes: methods(['load', 'apply', 'recover', 'inventory']),
    firewall: { ...methods(['load', 'apply', 'recover', 'current']),
      normalize: value => value, equal: (a, b) => a === b },
    guard: methods(['load', 'current', 'recover', 'protect', 'release']) });
  assert.equal(path.interfaceName, 'awgperm8');
});
