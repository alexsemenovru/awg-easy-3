'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellEnrollmentStore } = require('../lib/CellEnrollmentStore');
const { decodeInvitation } = require('../lib/CellInvitation');
const key = Buffer.alloc(32, 9).toString('base64url');
const options = { host: '192.0.2.1', port: 12345, controllerKey: key, now: 1000 };

async function fixture(t, io) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-enrollment-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cells.json');
  const store = new CellEnrollmentStore(file, io ? { io } : {});
  return { store, file, dir };
}
async function invite(store) {
  const code = await store.create(options);
  const payload = decodeInvitation(code, 1000);
  return { payload, request: { secret: payload.secret, cellKey: key,
    requestId: 'a'.repeat(32), registrationValid: true } };
}

test('enrollment survives reopen, returns no verifier, never persists bearer code', async t => {
  const { store, file } = await fixture(t);
  const { payload, request } = await invite(store);
  const result = await store.complete(payload.id, request, 1001);
  assert.deepEqual(result, { id: payload.id, status: 'consumed', cellKey: key });
  const reopened = new CellEnrollmentStore(file);
  assert.deepEqual(await reopened.complete(payload.id, request, 1002), result);
  await assert.rejects(reopened.complete(payload.id, { ...request, requestId: 'b'.repeat(32) }, 1002));
  assert.ok(!(await fs.readFile(file, 'utf8')).includes(payload.secret));
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('concurrent instances serialize conflicting registration and create operations', async t => {
  const { store, file } = await fixture(t);
  const { payload, request } = await invite(store);
  const other = new CellEnrollmentStore(file);
  const outcomes = await Promise.allSettled([
    store.complete(payload.id, request, 1001),
    other.complete(payload.id, { ...request, requestId: 'b'.repeat(32) }, 1001),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? other : store).create(options)));
  assert.equal((await store.read()).invitations.length, 9);
});

test('write failure reports failure, preserves disk and does not poison queue', async t => {
  let fail = false;
  const io = { ...fs, rename: async (...args) => {
    if (fail) throw new Error('injected rename failure');
    return fs.rename(...args);
  } };
  const { store, file, dir } = await fixture(t, io);
  const { payload, request } = await invite(store);
  const before = await fs.readFile(file, 'utf8');
  fail = true;
  await assert.rejects(store.complete(payload.id, request, 1001), /injected/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(dir), ['cells.json']);
  fail = false;
  assert.equal((await store.complete(payload.id, request, 1002)).status, 'consumed');
});

test('revocation and authenticated rejection remain effective after reopen', async t => {
  const { store, file } = await fixture(t);
  const first = await invite(store);
  await store.revoke(first.payload.id, 1001);
  const second = await invite(store);
  assert.equal((await store.complete(second.payload.id,
    { ...second.request, registrationValid: false }, 1001)).status, 'blocked');
  const other = new CellEnrollmentStore(file);
  await assert.rejects(other.complete(first.payload.id, first.request, 1002));
  await assert.rejects(other.complete(second.payload.id, second.request, 1002));
});

test('file sync failure never acknowledges or consumes an invitation', async t => {
  let fail = false;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[1] !== 'wx') return handle;
    return { writeFile: (...values) => handle.writeFile(...values),
      close: () => handle.close(), sync: async () => {
        if (fail) throw new Error('injected sync failure');
        await handle.sync();
      } };
  } };
  const { store, file } = await fixture(t, io);
  const { payload, request } = await invite(store);
  fail = true;
  await assert.rejects(store.complete(payload.id, request, 1001), /sync failure/);
  assert.equal((await new CellEnrollmentStore(file).read()).invitations[0].status, 'pending');
});

test('ambiguous failure after rename is safely retried from committed state', async t => {
  let fail = false;
  const io = { ...fs, rename: async (...args) => {
    await fs.rename(...args);
    if (fail) throw new Error('injected post-rename failure');
  } };
  const { store, file } = await fixture(t, io);
  const { payload, request } = await invite(store);
  fail = true;
  await assert.rejects(store.complete(payload.id, request, 1001), /post-rename/);
  const reopened = new CellEnrollmentStore(file);
  assert.equal((await reopened.complete(payload.id, request, 1002)).status, 'consumed');
  assert.equal((await reopened.read()).invitations.length, 1);
});

test('corrupt or future state is not silently replaced and duplicate cell keys fail', async t => {
  const { store, file } = await fixture(t);
  for (const raw of ['{', '{"version":2,"invitations":[]}', '{"version":1,"invitations":[{}]}']) {
    await fs.writeFile(file, raw);
    await assert.rejects(store.create(options), /Invalid cell enrollment/);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
  await fs.writeFile(file, '{"version":1,"invitations":[]}');
  const a = await invite(store);
  const b = await invite(store);
  await store.complete(a.payload.id, a.request, 1001);
  await assert.rejects(store.complete(b.payload.id, b.request, 1002));
  assert.equal((await store.read()).invitations[1].status, 'pending');
});
