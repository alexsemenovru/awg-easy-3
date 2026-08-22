'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  generateHeaderProtectionKey,
  generateOfficialProfile,
  renderInterfaceFields,
  renderPeerSecurity,
  validateProfile,
} = require('../lib/Awg3Config');

const validProfile = () => ({
  jc: 4,
  jmin: 35,
  jmax: 95,
  s1: 146,
  s2: 48,
  s3: 22,
  s4: 26,
  h1: '148736594-370455131',
  h2: '621025620-1240228083',
  h3: '1504827942-1530367889',
  h4: '1629521638-1833671031',
  headerProtectionKey: generateHeaderProtectionKey(),
  contentPaddingAddition: '50-100',
  rekeyAfterTime: '90-120',
  rekeyTimeout: '5-10',
  rejectAfterTime: '180-240',
  keepaliveTimeout: '10-20',
  maxHandshakeAttempts: '10-20',
  randomTrailers: true,
  disableCookies: false,
});

test('generates a canonical 32-byte header protection key', () => {
  const key = generateHeaderProtectionKey();
  assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.equal(Buffer.from(key, 'base64').toString('base64'), key);
});

test('validates and normalizes an AWG 3.1 profile', () => {
  const profile = validateProfile(validProfile());
  assert.equal(profile.jc, 4);
  assert.equal(profile.randomTrailers, true);
  assert.equal(profile.disableCookies, false);
});

test('renders official AWG config field names', () => {
  const rendered = renderInterfaceFields(validProfile());
  assert.match(rendered, /^Jc = 4$/m);
  assert.match(rendered, /^HeaderProtectionKey = [A-Za-z0-9+/]{43}=$/m);
  assert.match(rendered, /^ContentPaddingAddition = 50-100$/m);
  assert.match(rendered, /^RandomTrailers = on$/m);
  assert.match(rendered, /^DisableCookies = off$/m);
  assert.equal(renderPeerSecurity(), 'AdvancedSecurity = on');
});

test('rejects overlapping header ranges', () => {
  const profile = validProfile();
  profile.h2 = '300000000-700000000';
  assert.throws(() => validateProfile(profile), /must not overlap/);
});

test('rejects S padding shorter than the header-protection nonce', () => {
  const profile = validProfile();
  profile.s3 = 7;
  assert.throws(() => validateProfile(profile), /at least 8/);
});

test('rejects malformed header protection keys', () => {
  const profile = validProfile();
  profile.headerProtectionKey = 'not-a-key';
  assert.throws(() => validateProfile(profile), /exactly 32 bytes/);
});

test('generates an AWG 3.1 profile from current official Amnezia defaults', () => {
  const values = [20, 30, 40, 5];
  const profile = generateOfficialProfile({
    randomInt: () => values.shift(),
    generateKey: () => Buffer.alloc(32, 7).toString('base64'),
  });

  assert.equal(profile.jc, 5);
  assert.deepEqual([profile.s1, profile.s2, profile.s3, profile.s4], [20, 30, 40, 12]);
  assert.deepEqual([profile.h1, profile.h2, profile.h3, profile.h4], ['1', '2', '3', '4']);
  assert.equal(profile.contentPaddingAddition, '10-100');
  assert.equal(profile.randomTrailers, true);
  assert.equal(profile.disableCookies, true);
});
