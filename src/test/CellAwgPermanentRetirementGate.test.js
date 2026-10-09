'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { permanentCellPlan, permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
const { CellAwgPermanentRetirementGate } = require('../lib/CellAwgPermanentRetirementGate');

const key = () => crypto.randomBytes(32).toString('base64');
function fixture() {
  const serverPublicKey = key();
  const descriptor = { version: 1, endpointHost: '198.51.100.42', endpointPort: 53084,
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
    serverPublicKey, profile: generateOfficialProfile() };
  const connection = { status: 'registered', permanent: { privateKey: key(),
    presharedKey: key() }, controllerPath: descriptor };
  const record = { status: 'consumed', permanentDescriptor: descriptor,
    cellAddress: descriptor.cellAddress, awgPublicKey: key(),
    awgPresharedKey: connection.permanent.presharedKey };
  const keyManager = { derivePublicKey: async () => serverPublicKey };
  return { descriptor, connection, record, keyManager };
}

function gateFor(plan, keyManager) {
  const calls = [];
  const deployment = { stateDirectory: 'private', runner: async () => {},
    store: { read: async () => ({ ...plan, version: 1 }) },
    buildPath: () => ({ interfaceName: 'awgperm8', verifyOperational: async () => true }) };
  return { gate: new CellAwgPermanentRetirementGate({ deployment, keyManager,
    verifierFactory: options => ({ verify: async () => { calls.push(options); return true; } }) }), calls };
}

test('cell retirement gate binds signed descriptor and private identity to exact owned plan', async () => {
  const f = fixture();
  const plan = permanentCellPlan({ connection: f.connection, interfaceName: 'awgperm8' });
  const { gate, calls } = gateFor(plan, f.keyManager);
  assert.equal(await gate.verifyCell(f.connection), true);
  assert.equal(calls[0].peerPublicKey, f.descriptor.serverPublicKey);
  assert.equal(calls[0].role, 'cell');
  assert.equal(await gate.verifyCell({ ...f.connection,
    controllerPath: { ...f.descriptor, cellAddress: '10.91.8.9' } }), false);
  assert.equal(await gate.verifyCell({ ...f.connection,
    permanent: { ...f.connection.permanent, privateKey: key() } }), false);
  assert.equal(calls.length, 1);
});

test('controller retirement gate refuses another AWG peer or changed signed cell address', async () => {
  const f = fixture(), privateKey = key();
  const plan = await permanentControllerPlan({ privateKey, descriptor: f.descriptor,
    peers: [{ cellAddress: f.record.cellAddress, awgPublicKey: f.record.awgPublicKey,
      awgPresharedKey: f.record.awgPresharedKey }], interfaceName: 'awgperm8',
    keyManager: f.keyManager });
  const { gate, calls } = gateFor(plan, f.keyManager);
  assert.equal(await gate.verifyController(f.record), true);
  assert.equal(calls[0].peerPublicKey, f.record.awgPublicKey);
  assert.equal(calls[0].role, 'controller');
  assert.equal(await gate.verifyController({ ...f.record, awgPublicKey: key() }), false);
  assert.equal(await gate.verifyController({ ...f.record, cellAddress: '10.91.8.9' }), false);
  assert.equal(calls.length, 1);
});
