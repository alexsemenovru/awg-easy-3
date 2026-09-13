'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { CellConnectionStore } = require('../lib/CellConnectionStore');
const { identity } = require('../lib/CellRegistration');
const { createInvitation, decodeInvitation } = require('../lib/CellInvitation');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-connection-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const identities = new ControlIdentityStore(path.join(dir, 'identity.json'));
  await identities.create('cell');
  const file = path.join(dir, 'connection.json');
  const code = createInvitation({ host: '192.0.2.1', port: 12345, controllerKey: identity().publicKey }).code;
  return { identities, file, code };
}
const success = async ({ request }) => ({ status: 'registered', controllerKey: request.controllerKey,
  cellKey: request.cellKey, invitationId: request.invitationId });

test('pending request survives connection loss and reopen; secret removed after success', async t => {
  const { identities, file, code } = await fixture(t);
  let seen;
  const first = new CellConnectionStore(file, identities, { connect: async ({ request }) => {
    seen = request;
    throw new Error('connection lost');
  } });
  await first.begin(code);
  await assert.rejects(first.resume(), /connection lost/);
  const reopened = new CellConnectionStore(file, identities, { connect: async options => {
    assert.deepEqual(options.request, seen);
    return success(options);
  } });
  assert.deepEqual(await reopened.resume(), { status: 'registered' });
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes(decodeInvitation(code).secret));
  assert.ok(!raw.includes('signature'));
  assert.deepEqual(await reopened.resume(), { status: 'registered' });
  await assert.rejects(reopened.begin(code), /already exists/);
});

test('failed local commit retries exactly the same registration', async t => {
  const { identities, file, code } = await fixture(t);
  let fail = false;
  const requests = [];
  const store = new CellConnectionStore(file, identities, { connect: async options => {
    requests.push(options.request);
    return success(options);
  }, io: { ...fs, rename: async (...args) => {
    if (fail) throw new Error('disk failure');
    return fs.rename(...args);
  } } });
  await store.begin(code);
  fail = true;
  await assert.rejects(store.resume(), /disk failure/);
  fail = false;
  await store.resume();
  assert.deepEqual(requests[0], requests[1]);
});

test('wrong confirmation and corrupt state cannot silently pair a cell', async t => {
  const { identities, file, code } = await fixture(t);
  const store = new CellConnectionStore(file, identities, { connect: async () => ({ status: 'registered' }) });
  await store.begin(code);
  await assert.rejects(store.resume(), /mismatch/);
  assert.equal((await store.read()).status, 'pending');
  await fs.writeFile(file, '{');
  await assert.rejects(store.resume(), /Invalid cell connection/);
  await assert.rejects(store.begin(code), /Invalid cell connection/);
  assert.equal(await fs.readFile(file, 'utf8'), '{');
});
