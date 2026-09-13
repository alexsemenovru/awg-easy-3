'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { identity, signRegistration } = require('../lib/CellRegistration');
const { createInvitation, decodeInvitation } = require('../lib/CellInvitation');
const { CellRegistrationHandler, parseRegistration, MAX_BYTES } = require('../lib/CellRegistrationHandler');

function request() {
  const invitation = decodeInvitation(createInvitation({ host: '192.0.2.1', port: 12345,
    controllerKey: identity().publicKey }).code);
  return signRegistration(invitation, identity().privateKey);
}
const encode = value => Buffer.from(JSON.stringify(value));

test('wire parser accepts only the complete registration schema', () => {
  const valid = request();
  assert.deepEqual(parseRegistration(encode(valid)), valid);
  for (const bad of [null, [], {}, { ...valid, registrationValid: true },
    { ...valid, command: 'uninstall' }, { ...valid, version: '1' },
    { ...valid, secret: 'bad' }, { ...valid, signature: valid.signature + '=' }]) {
    assert.throws(() => parseRegistration(encode(bad)));
  }
  for (const bad of [Buffer.alloc(MAX_BYTES + 1), Buffer.from([0xff]), Buffer.from('{'), 'not a buffer']) {
    assert.throws(() => parseRegistration(bad));
  }
});

test('malformed input never reaches registration and exceptions do not leak', async () => {
  let calls = 0;
  const handler = new CellRegistrationHandler({ register: async () => {
    calls += 1;
    throw new Error('private path /secret/key and invitation token');
  } });
  const invalid = await handler.handle(Buffer.from('{}'));
  assert.equal(calls, 0);
  assert.deepEqual(await handler.handle(encode(request())), invalid);
  assert.deepEqual(invalid, { ok: false, error: 'registration_unavailable' });
});

test('handler limits concurrency without an unbounded pending queue', async () => {
  let release;
  const handler = new CellRegistrationHandler({ register: () => new Promise(resolve => { release = resolve; }) },
    { maxInFlight: 1 });
  const pending = handler.handle(encode(request()));
  assert.deepEqual(await handler.handle(encode(request())), { ok: false, error: 'registration_busy' });
  release({ status: 'registered' });
  assert.deepEqual(await pending, { ok: true, receipt: { status: 'registered' } });
  assert.equal(handler.inFlight, 0);
});

test('malformed requests consume rate budget and monotonic refill is bounded', async () => {
  let clock = 1000;
  const handler = new CellRegistrationHandler({ register: async () => ({}) },
    { burst: 1, refillMs: 100, monotonicNow: () => clock });
  await handler.handle(Buffer.from('{}'));
  assert.equal((await handler.handle(encode(request()))).error, 'registration_busy');
  clock = 900;
  assert.equal((await handler.handle(encode(request()))).error, 'registration_busy');
  clock = 1100;
  assert.equal((await handler.handle(encode(request()))).ok, true);
  assert.equal((await handler.handle(encode(request()))).error, 'registration_busy');
});
