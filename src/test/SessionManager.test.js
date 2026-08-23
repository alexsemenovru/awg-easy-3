'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SessionManager } = require('../lib/SessionManager');

const fixture = () => {
  let secret = 'first-persistent-session-secret';
  let now = 1_800_000_000_000;
  const manager = new SessionManager({
    store: { load: async () => ({ auth: { sessionSecret: secret } }) },
    clock: () => now,
    randomBytes: (length) => Buffer.alloc(length, 37),
    lifetimeMs: 60 * 60 * 1000,
  });
  return {
    advance: (milliseconds) => { now += milliseconds; },
    manager,
    rotate: () => { secret = 'second-persistent-session-secret'; },
  };
};

test('creates and verifies a signed session without storing credentials', async () => {
  const { manager } = fixture();
  const token = await manager.create();
  assert.equal(await manager.verify(token), true);
  const decoded = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(decoded).sort(), ['exp', 'iat', 'sid', 'v']);
});

test('rejects tampering, expiry and a rotated password session secret', async () => {
  const state = fixture();
  const token = await state.manager.create();
  assert.equal(await state.manager.verify(`${token}x`), false);
  state.advance(60 * 60 * 1000);
  assert.equal(await state.manager.verify(token), false);

  const fresh = fixture();
  const oldToken = await fresh.manager.create();
  fresh.rotate();
  assert.equal(await fresh.manager.verify(oldToken), false);
});

test('emits an HTTP-only strict cookie suitable for the VPN-only panel', async () => {
  const { manager } = fixture();
  const cookie = manager.cookie(await manager.create());
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.match(manager.cookie(await manager.create(), { secure: true }), /; Secure$/);
  assert.match(manager.clearCookie(), /Max-Age=0/);
});
