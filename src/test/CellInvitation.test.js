'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInvitation, decodeInvitation, completeInvitation, revokeInvitation } = require('../lib/CellInvitation');
const key = Buffer.alloc(32, 7).toString('base64url');
const now = 100000;
const options = { host: '192.0.2.1', port: 12345, controllerKey: key, now };
const setup = () => {
  const { code, record } = createInvitation(options);
  const payload = decodeInvitation(code, now);
  return { code, record, payload, request: { secret: payload.secret,
    requestId: 'a'.repeat(32), cellKey: key, registrationValid: true } };
};

test('cell invitations roundtrip without storing the bearer secret', () => {
  for (const host of ['192.0.2.1', '2001:db8::1', 'controller.example']) {
    const { code, record } = createInvitation({ ...options, host });
    const payload = decodeInvitation(code, now);
    assert.equal(payload.host, host);
    assert.equal(payload.controllerKey, key);
    assert.equal(payload.id, record.id);
    assert.ok(!JSON.stringify(record).includes(payload.secret));
    assert.ok(!code.includes(host));
    assert.notEqual(code, createInvitation({ ...options, host }).code);
  }
});

test('invalid addresses, ports, keys and lifetime are rejected', () => {
  for (const patch of [{ host: '' }, { host: 'x/evil' }, { host: 'x\n' }, { host: '-x' },
    { port: 0 }, { port: '1234' }, { port: 65536 }, { controllerKey: 'key' },
    { lifetimeMs: 0 }, { lifetimeMs: 86400001 }, { now: NaN }]) {
    assert.throws(() => createInvitation({ ...options, ...patch }));
  }
});

test('decode rejects malformed, oversized, unsupported and expired codes', () => {
  const { code, payload } = setup();
  for (const bad of ['', 'x'.repeat(2049), 'vpn://' + code, code + '=', 'e30', null]) {
    assert.throws(() => decodeInvitation(bad, now));
  }
  const altered = Buffer.from(JSON.stringify({ ...payload, version: 2 })).toString('base64url');
  assert.throws(() => decodeInvitation(altered, now));
  assert.throws(() => decodeInvitation(code, payload.expiresAt));
});

test('invalid secret cannot consume or block a pending invitation', () => {
  const { record, request } = setup();
  const snapshot = JSON.stringify(record);
  assert.throws(() => completeInvitation(record, { ...request, secret: key }, now));
  assert.equal(JSON.stringify(record), snapshot);
  assert.equal(completeInvitation(record, request, now).status, 'consumed');
});

test('successful registration is idempotent only for the same request and cell', () => {
  const { record, request } = setup();
  const consumed = completeInvitation(record, request, now);
  assert.equal(record.status, 'pending');
  assert.deepEqual(completeInvitation(consumed, request, now + 1), consumed);
  assert.throws(() => completeInvitation(consumed, { ...request, requestId: 'b'.repeat(32) }, now));
  assert.throws(() => completeInvitation(consumed, { ...request, cellKey: Buffer.alloc(32, 8).toString('base64url') }, now));
  assert.throws(() => completeInvitation(consumed, request, record.expiresAt));
});

test('authenticated invalid registration blocks, owner revocation prevents enrollment', () => {
  const { record, request } = setup();
  for (const patch of [{ registrationValid: false }, { requestId: 'bad' }, { cellKey: 'bad' }]) {
    const blocked = completeInvitation(record, { ...request, ...patch }, now);
    assert.equal(blocked.status, 'blocked');
    assert.throws(() => completeInvitation(blocked, request, now));
  }
  const revoked = revokeInvitation(record, now);
  assert.throws(() => completeInvitation(revoked, request, now));
  assert.deepEqual(revokeInvitation(revoked, now + 1), revoked);
  assert.throws(() => revokeInvitation(completeInvitation(record, request, now), now));
});

test('expiry and invalid clock are rejected without mutating the record', () => {
  const { record, request } = setup();
  for (const clock of [now - 1, record.expiresAt, NaN]) {
    assert.throws(() => completeInvitation(record, request, clock));
  }
  assert.equal(record.status, 'pending');
});
