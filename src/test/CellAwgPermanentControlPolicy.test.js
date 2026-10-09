'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { permanentControlPolicySnapshot } = require('../lib/CellAwgPermanentControlPolicy');
const { routingGuardSnapshot } = require('../lib/CellNftOwnership');
const { CellRoutingGuard } = require('../lib/CellRoutingGuard');
const { CellNftTransaction } = require('../lib/CellNftTransaction');

const key = () => crypto.randomBytes(32).toString('base64');
const descriptor = () => ({ version: 1, endpointHost: 'controller.example', endpointPort: 53084,
  controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2', controlPort: 53083,
  serverPublicKey: key(), profile: generateOfficialProfile() });

test('controller policy groups multiple peers by chain and drops WAN fallback for each', () => {
  const snapshot = permanentControlPolicySnapshot({ role: 'controller',
    interfaceName: 'awgperm8', descriptor: descriptor(),
    peerAddresses: ['10.91.8.3', '10.91.8.2'] });
  const rules = snapshot.nftables.filter(item => item.rule).map(item => item.rule);
  assert.deepEqual(rules.map(rule => rule.chain), ['input', 'input', 'input',
    'output', 'output', 'output', 'output', 'output', 'forward', 'forward']);
  assert.deepEqual(rules.slice(5, 7).map(rule => rule.expr[0].match.right),
    ['10.91.8.2', '10.91.8.3']);
  assert.ok(rules.slice(5, 7).every(rule => rule.expr.at(-1).drop === null));
  assert.equal(rules[0].expr.at(-2).match.left.payload.field, 'dport');
});

test('cell policy admits only controller responses and blocks default-route fallback', () => {
  const snapshot = permanentControlPolicySnapshot({ role: 'cell',
    interfaceName: 'awgperm8', descriptor: descriptor() });
  const rules = snapshot.nftables.filter(item => item.rule).map(item => item.rule);
  assert.equal(rules.length, 7);
  assert.equal(rules[0].expr.at(-2).match.left.payload.field, 'sport');
  assert.equal(rules[2].expr.at(-2).match.left.payload.field, 'dport');
  assert.equal(rules[3].expr[0].match.right, '10.91.8.1');
  assert.equal(rules[3].expr.at(-1).drop, null);
});

test('permanent control policy rejects public, duplicate or unrelated peer addresses', () => {
  const base = { role: 'controller', interfaceName: 'awgperm8', descriptor: descriptor() };
  for (const peerAddresses of [['8.8.8.8'], ['10.91.8.2', '10.91.8.2'],
    ['fd90::2'], ['10.91.8.1']]) {
    assert.throws(() => permanentControlPolicySnapshot({ ...base, peerAddresses }));
  }
  assert.throws(() => permanentControlPolicySnapshot({ ...base,
    role: 'cell', peerAddresses: ['10.91.8.2'] }));
});

test('dedicated permanent control and guard tables are accepted by strict ownership components', () => {
  const guardTable = 'awg_easy_3_control_guard';
  const policyTable = 'awg_easy_3_control';
  const guard = new CellRoutingGuard({ journalPath: 'control-guard.json', table: guardTable });
  const nft = new CellNftTransaction({ journalPath: 'control-policy.json',
    activateGuard: async () => {}, table: policyTable });
  const expected = routingGuardSnapshot(['awgperm8'], guardTable);
  assert.deepEqual(guard.snapshot(['awgperm8']), expected);
  assert.equal(nft.normalize(permanentControlPolicySnapshot({ role: 'cell',
    interfaceName: 'awgperm8', descriptor: descriptor() })).nftables[0].table.name, policyTable);
  assert.throws(() => nft.normalize(expected), /Foreign or unsupported/);
});
