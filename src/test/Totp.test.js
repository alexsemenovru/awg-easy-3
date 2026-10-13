'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { codeAt, generateSecret, matchingStep, provisioningUri } = require('../lib/Totp');

test('matches the RFC 6238 SHA-1 vector truncated to six digits', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(codeAt(secret, 1), '287082');
  assert.equal(matchingStep(secret, '287082', 59_000), 1);
  assert.equal(matchingStep(secret, '287082', 59_000, 1), null);
  assert.equal(matchingStep(secret, 'not-a-code', 59_000), null);
});

test('creates an interoperable provisioning URI without a remote service', () => {
  const secret = generateSecret(length => Buffer.alloc(length, 42));
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const uri = new URL(provisioningUri(secret));
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.searchParams.get('secret'), secret);
  assert.equal(uri.searchParams.get('digits'), '6');
  assert.equal(uri.searchParams.get('period'), '30');
});
