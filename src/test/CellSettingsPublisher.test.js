'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { CellSettingsPublisher } = require('../lib/CellSettingsPublisher');
const { CellSettingsReceiver } = require('../lib/CellSettingsReceiver');
const { acknowledgeApplied, signSettingsAck } = require('../lib/CellSettingsAck');

test('revision and applied acknowledgement persist, stale or forged acknowledgements fail', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-publisher-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = new ControlIdentityStore(path.join(dir, 'controller.json'));
  const cell = new ControlIdentityStore(path.join(dir, 'cell.json'));
  const c = await controller.create('controller');
  const p = await cell.create('cell');
  const file = path.join(dir, 'desired.json');
  const publisher = new CellSettingsPublisher(file, controller, p.publicKey);
  assert.deepEqual(await publisher.status(), { desiredRevision: null,
    confirmedRevision: null, awaitingAck: false });
  let fail = false;
  const receiver = new CellSettingsReceiver(path.join(dir, 'applied.json'), {
    controllerKey: c.publicKey, cellKey: p.publicKey,
    apply: async () => { if (fail) throw new Error('runtime failure'); },
  });
  const first = await publisher.publish({ schema: 1, clients: [] });
  assert.equal(first.revision, 1);
  await assert.rejects(acknowledgeApplied(receiver, cell), /No applied/);
  await receiver.receive(first);
  const ack = await acknowledgeApplied(receiver, cell);
  await publisher.acknowledge(ack);
  assert.deepEqual(await publisher.status(), { desiredRevision: 1,
    confirmedRevision: 1, awaitingAck: false });
  assert.equal((await publisher.load()).ack.revision, 1);
  assert.equal((await publisher.load()).confirmed.desired.revision, 1);
  const reopened = new CellSettingsPublisher(file, controller, p.publicKey);
  const second = await reopened.publish({ schema: 1, clients: [] });
  assert.equal(second.revision, 2);
  assert.equal((await reopened.load()).ack, null);
  assert.equal((await reopened.load()).confirmed.desired.revision, 1);
  assert.deepEqual(await reopened.status(), { desiredRevision: 2,
    confirmedRevision: 1, awaitingAck: true });
  await assert.rejects(reopened.acknowledge(ack), /mismatch/);
  fail = true;
  await assert.rejects(receiver.receive(second), /runtime failure/);
  assert.equal((await reopened.load()).confirmed.desired.revision, 1);
  assert.equal((await acknowledgeApplied(receiver, cell)).revision, 1);
  await assert.rejects(reopened.acknowledge({ ...signSettingsAck(second, p.privateKey), hash: 'f'.repeat(64) }));
  fail = false;
  await receiver.receive(second);
  await reopened.acknowledge(await acknowledgeApplied(receiver, cell));
  assert.equal((await reopened.load()).ack.revision, 2);
  assert.equal((await reopened.load()).confirmed.desired.revision, 2);
  assert.deepEqual(await reopened.status(), { desiredRevision: 2,
    confirmedRevision: 2, awaitingAck: false });
  const revisions = await Promise.all([publisher.publish({ schema: 1, clients: [] }), reopened.publish({ schema: 1, clients: [] })]);
  assert.deepEqual(revisions.map(v => v.revision), [3, 4]);
  assert.equal((await reopened.load()).confirmed.desired.revision, 2);
});

test('older acknowledged journal retains its last confirmed settings on next publish', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-publisher-legacy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = new ControlIdentityStore(path.join(dir, 'controller.json'));
  const cell = new ControlIdentityStore(path.join(dir, 'cell.json'));
  await controller.create('controller');
  const p = await cell.create('cell');
  const file = path.join(dir, 'desired.json');
  const publisher = new CellSettingsPublisher(file, controller, p.publicKey);
  const desired = await publisher.publish({ schema: 1, clients: [] });
  await publisher.acknowledge(signSettingsAck(desired, p.privateKey));
  const old = await publisher.load();
  delete old.confirmed;
  await fs.writeFile(file, JSON.stringify(old));
  assert.equal((await publisher.load()).confirmed.desired.revision, 1);
  await publisher.publish({ schema: 1, clients: [] });
  assert.equal((await publisher.load()).confirmed.desired.revision, 1);
  const corrupted = await publisher.load();
  corrupted.confirmed.ack.signature = 'invalid';
  await fs.writeFile(file, JSON.stringify(corrupted));
  await assert.rejects(publisher.load(), /acknowledgement mismatch/);
});

test('Linux publisher refuses linked state and a public state directory',
  { skip: process.platform === 'win32' }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-publisher-private-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const controller = new ControlIdentityStore(path.join(dir, 'controller.json'));
    await controller.create('controller');
    const cell = new ControlIdentityStore(path.join(dir, 'cell.json'));
    const p = await cell.create('cell');
    const file = path.join(dir, 'desired.json');
    const publisher = new CellSettingsPublisher(file, controller, p.publicKey);
    await publisher.publish({ schema: 1, clients: [] });
    const alias = `${file}.alias`;
    await fs.link(file, alias);
    await assert.rejects(publisher.load(), /Invalid published settings file/);
    await fs.unlink(alias);
    const saved = await publisher.load();
    await fs.chmod(dir, 0o755);
    await assert.rejects(publisher.load(), /Private published settings directory required/);
    await assert.rejects(publisher.save(saved), /Private published settings directory required/);
  });
