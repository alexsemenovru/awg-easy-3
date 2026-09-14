'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCellSettings } = require('../lib/CellSettingsSchema');
const key = n => Buffer.alloc(32, n).toString('base64');
const client = () => ({ id: 'client-1', publicKey: key(1), address4: '10.8.0.2',
  address6: 'fd42::2', networkGroup: 'home', ipv4Enabled: true, ipv6Enabled: true,
  geoPolicy: { mode: 'block', countries: ['ru'] } });
const schema = value => ({ schema: 1, clients: [value] });

test('cell assignment preserves Home/Guest, family flags and GeoIP without granting defaults', () => {
  const normalized = validateCellSettings(schema(client()));
  assert.deepEqual(normalized.clients[0].geoPolicy, { mode: 'block', countries: ['RU'] });
  assert.equal(normalized.clients[0].networkGroup, 'home');
  assert.ok(Object.isFrozen(normalized.clients));
  assert.equal(validateCellSettings(schema({ ...client(), networkGroup: 'guest', ipv4Enabled: false,
    ipv6Enabled: false })).clients[0].ipv4Enabled, false);
  assert.deepEqual(validateCellSettings({ schema: 1, clients: [] }), { schema: 1, clients: [] });
});

test('unknown settings, command injection and private client keys are rejected', () => {
  for (const patch of [{ privateKey: key(3) }, { command: 'flush ruleset' }, { exit: 'direct' },
    { ipv4Enabled: 'false' }, { networkGroup: 'admin' }, { address4: '10.8.0.2/32' },
    { address6: 'fe80::2%eth0' }, { address6: undefined }, { publicKey: 'bad' },
    { geoPolicy: { mode: 'off', countries: ['RU'] } }, { geoPolicy: { mode: 'block', countries: [] } }]) {
    assert.throws(() => validateCellSettings(schema({ ...client(), ...patch })));
  }
  const missing = client();
  delete missing.ipv4Enabled;
  assert.throws(() => validateCellSettings(schema(missing)));
  assert.throws(() => validateCellSettings({ ...schema(client()), shell: 'anything' }));
});

test('duplicate identities and alternate spellings of IPv6 cannot bypass uniqueness', () => {
  for (const patch of [{ id: 'client-1' }, { publicKey: key(1) }, { address4: '10.8.0.2' },
    { address6: 'fd42:0:0:0:0:0:0:2' }]) {
    assert.throws(() => validateCellSettings({ schema: 1, clients: [client(), {
      ...client(), id: 'client-2', publicKey: key(2), address4: '10.8.0.3', address6: 'fd42::3', ...patch,
    }] }));
  }
});
