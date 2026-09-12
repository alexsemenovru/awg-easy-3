'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeGeoPolicy, validatePrefixes } = require('../lib/GeoIpPolicy');
const { renderNftablesPolicy } = require('../lib/NftablesPolicy');

const base = { home4: ['10.8.0.2'], guest4: ['10.8.0.3'], ipv6Subnet: 'fd42::/64',
  home6: ['fd42::2'], guest6: ['fd42::3'] };
// Synthetic data only; these documentation networks do not represent a country.
const database = { RU: { ipv4: ['192.0.2.0/24'], ipv6: ['2001:db8::/32'] } };
const client = mode => ({ address4: '10.8.0.3', address6: 'fd42::3', policy: { mode, countries: ['RU'] } });

test('single-address database ranges become nft-compatible host prefixes', () => {
  assert.deepEqual(validatePrefixes(['192.0.2.1-192.0.2.1'], 4), ['192.0.2.1/32']);
  assert.deepEqual(validatePrefixes(['2001:db8::1-2001:0db8::1'], 6), ['2001:db8::1/128']);
});

test('normalizes country codes and rejects ambiguous empty active policies', () => {
  assert.deepEqual(normalizeGeoPolicy({ mode: 'block', countries: ['ru', 'IR', 'RU'] }), { mode: 'block', countries: ['IR', 'RU'] });
  for (const input of [{ mode: 'allow', countries: [] }, { mode: 'direct', countries: ['RU'] },
    { mode: 'block', countries: ['Russia'] }, { mode: 'block', countries: ['RU;drop'] }, null]) {
    assert.throws(() => normalizeGeoPolicy(input));
  }
});

test('GeoIP off leaves legacy firewall output byte-identical', () => {
  assert.equal(renderNftablesPolicy(base), renderNftablesPolicy({ ...base, geoClients: [client('off')] }));
});

test('both families block WAN traffic before established accepts but preserve Home rules', () => {
  const rules = renderNftablesPolicy({ ...base, geoClients: [client('block')], geoDatabase: database });
  assert.equal((rules.match(/comment "GeoIP /g) || []).length, 4);
  assert.ok(rules.indexOf('isolate guest peers') < rules.indexOf('GeoIP outbound'));
  assert.ok(rules.indexOf('GeoIP inbound') < rules.indexOf('ct state established,related'));
  assert.match(rules, /iifname "awg0" oifname "eth0" ip saddr 10\.8\.0\.3 ip daddr @geo4_/);
  assert.match(rules, /iifname "eth0" oifname "awg0" ip6 daddr fd42::3 ip6 saddr @geo6_/);
  assert.match(rules, /flags interval\n    auto-merge/);
  const input = rules.slice(rules.indexOf('  chain input'), rules.indexOf('  chain forward'));
  assert.doesNotMatch(input, /GeoIP/);
});

test('allow-only uses inverse set membership and shares sets across clients', () => {
  const rules = renderNftablesPolicy({ ...base, geoClients: [client('allow'),
    { address4: '10.8.0.2', policy: { mode: 'block', countries: ['RU'] } }], geoDatabase: database });
  assert.match(rules, /ip daddr != @geo4_/);
  assert.match(rules, /ip6 saddr != @geo6_/);
  assert.equal((rules.match(/  set geo4_/g) || []).length, 1);
});

test('missing data, inactive peers and malformed prefixes fail instead of silently unfiltering', () => {
  assert.throws(() => renderNftablesPolicy({ ...base, geoClients: [client('block')] }), /unavailable/);
  assert.throws(() => renderNftablesPolicy({ ...base, geoClients: [{ ...client('block'), address4: '10.8.0.9' }], geoDatabase: database }), /not active/);
  for (const value of ['0.0.0.0/0', '192.0.2.0/', '192.0.2.0/24\nflush ruleset', '192.0.2.0/33', '192.0.2.0/024']) {
    assert.throws(() => validatePrefixes([value], 4));
  }
  assert.throws(() => validatePrefixes(['fe80::1%eth0/64'], 6));
  assert.throws(() => renderNftablesPolicy({ ...base, geoClients: [client('block'), client('allow')], geoDatabase: database }), /Duplicate/);
});
