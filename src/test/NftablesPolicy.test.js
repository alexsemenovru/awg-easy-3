'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TABLE_NAME,
  buildAtomicNftBatch,
  renderNftablesPolicy,
} = require('../lib/NftablesPolicy');

const basePolicy = () => ({
  interfaceName: 'awg0',
  wanInterface: 'eth0',
  ipv4Subnet: '10.8.0.0/24',
  home4: ['10.8.0.2'],
  guest4: ['10.8.0.3'],
});

test('renders only the dedicated AWG-Easy 3 table', () => {
  const rules = renderNftablesPolicy(basePolicy());
  assert.match(rules, new RegExp(`table inet ${TABLE_NAME}`));
  assert.doesNotMatch(rules, /flush ruleset/);
  assert.doesNotMatch(rules, /delete table/);
  assert.doesNotMatch(rules, /iptables/);
});

test('allows home peer traffic and isolates guest peer traffic', () => {
  const rules = renderNftablesPolicy(basePolicy());
  assert.match(rules, /ip saddr @home4 ip daddr @home4 accept/);
  assert.match(rules, /iifname "awg0" oifname "awg0" drop comment "isolate guest peers"/);
  assert.match(rules, /ip saddr @guest4 ip daddr 10\.8\.0\.0\/24 drop/);
  assert.match(rules, /ip saddr @home4 tcp dport 51821 accept/);
});

test('adds IPv6 home and guest policy when enabled', () => {
  const rules = renderNftablesPolicy({
    ...basePolicy(),
    ipv6Subnet: 'fd42:8:3::/64',
    home6: ['fd42:8:3::2'],
    guest6: ['fd42:8:3::3'],
  });
  assert.doesNotMatch(rules, /block_ipv6|RU-direct/);
  assert.match(rules, /ip6 saddr @home6 ip6 daddr @home6 accept/);
});

test('both Home-family permits precede the shared inter-peer isolation drop', () => {
  const rules = renderNftablesPolicy({
    ...basePolicy(),
    ipv6Subnet: 'fd42:8:3::/64',
    home6: ['fd42:8:3::2'],
    guest6: ['fd42:8:3::3'],
  });
  const lines = rules.split('\n');
  const home4 = lines.findIndex((line) => line.includes('ip saddr @home4 ip daddr @home4 accept'));
  const home6 = lines.findIndex((line) => line.includes('ip6 saddr @home6 ip6 daddr @home6 accept'));
  const isolation = lines.findIndex((line) => /iifname "awg0" oifname "awg0" drop/.test(line));
  assert.ok(home4 >= 0 && home6 >= 0 && isolation > home4 && isolation > home6,
    'a family-neutral drop must not shadow the IPv6 Home permit');
  assert.equal(lines.filter((line) => /iifname "awg0" oifname "awg0" drop/.test(line)).length, 1);
  assert.ok(isolation < lines.findIndex((line) => line.includes('AWG IPv4 to WAN')));
  assert.ok(isolation < lines.findIndex((line) => line.includes('AWG IPv6 to WAN')));
});

test('adds NAT66 only for the project IPv6 prefix when requested', () => {
  const policy = renderNftablesPolicy({
    interfaceName: 'awg0',
    wanInterface: 'eth0',
    ipv4Subnet: '10.8.0.0/24',
    ipv6Subnet: 'fd42:8:3::/64',
    nat66: true,
    home4: ['10.8.0.2'],
    guest4: [],
    home6: ['fd42:8:3::2'],
  });
  assert.match(policy, /ip6 saddr fd42:8:3::\/64 masquerade/);
  assert.throws(() => renderNftablesPolicy({
    home4: ['10.8.0.2'], guest4: [], nat66: true,
  }), /requires ipv6Subnet/);
});

test('omits the elements clause for empty nftables sets', () => {
  const policy = renderNftablesPolicy({
    ...basePolicy(),
    guest4: [],
    ipv6Subnet: 'fd42:8:3::/64',
    home6: ['fd42:8:3::2'],
    guest6: [],
  });

  assert.doesNotMatch(policy, /elements\s*=\s*\{\s*\}/);
  assert.match(policy, /set guest4 \{\n    type ipv4_addr\n  \}/);
  assert.match(policy, /set guest6 \{\n    type ipv6_addr\n  \}/);
});

test('rejects peer membership overlap', () => {
  assert.throws(
    () => renderNftablesPolicy({ ...basePolicy(), guest4: ['10.8.0.2'] }),
    /both home and guest/,
  );
});

test('rejects values that could inject nft syntax', () => {
  assert.throws(
    () => renderNftablesPolicy({ ...basePolicy(), interfaceName: 'awg0;flush' }),
    /interfaceName/,
  );
  assert.throws(
    () => renderNftablesPolicy({ ...basePolicy(), home4: ['10.8.0.2; drop'] }),
    /invalid IPv4/,
  );
});

test('replaces only its own existing table in one nft batch', () => {
  const policy = renderNftablesPolicy(basePolicy());
  const initial = buildAtomicNftBatch(policy);
  const replacement = buildAtomicNftBatch(policy, { tableExists: true });

  assert.match(initial, /^# Managed by AWG-Easy 3/);
  assert.match(replacement, /^delete table inet awg_easy_3\n# Managed by AWG-Easy 3/);
  assert.equal((replacement.match(/delete table/g) || []).length, 1);
});

test('refuses destructive statements in externally supplied policy text', () => {
  assert.throws(
    () => buildAtomicNftBatch(`flush ruleset\ntable inet ${TABLE_NAME} {}`),
    /forbidden destructive/,
  );
});
