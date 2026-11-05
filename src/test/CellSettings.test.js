'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { identity } = require('../lib/CellRegistration');
const { signSettings, verifySettings } = require('../lib/CellSettings');
const { CellSettingsReceiver } = require('../lib/CellSettingsReceiver');

test('settings signature binds recipient, revision and exact payload', () => {
  const controller = identity();
  const cell = identity();
  const trust = { controllerKey: controller.publicKey, cellKey: cell.publicKey };
  const envelope = signSettings({ cellKey: cell.publicKey, revision: 1, settings: { test: true } }, controller.privateKey);
  assert.deepEqual(verifySettings(envelope, trust).settings, { test: true });
  for (const patch of [{ revision: 2 }, { payload: '{}' }, { cellKey: identity().publicKey }]) {
    assert.throws(() => verifySettings({ ...envelope, ...patch }, trust));
  }
  assert.throws(() => verifySettings(envelope, { ...trust, controllerKey: identity().publicKey }));
});

test('failure keeps applied settings; revisions persist and startup restores last good settings', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = identity();
  const cellKey = identity().publicKey;
  const sign = (revision, settings) => signSettings({ cellKey, revision, settings }, controller.privateKey);
  let fail = false;
  const applications = [];
  const adapters = { controllerKey: controller.publicKey, cellKey,
    validate: settings => { if (typeof settings.test !== 'number') throw new Error('schema'); },
    apply: async settings => { if (fail) throw new Error('runtime failure'); applications.push(settings.test); } };
  const file = path.join(dir, 'settings.json');
  const receiver = new CellSettingsReceiver(file, adapters);
  const first = sign(1, { test: 1 });
  await receiver.receive(first);
  await receiver.receive(first);
  assert.deepEqual(applications, [1]);
  await assert.rejects(receiver.receive(sign(1, { test: 99 })), /Conflicting/);
  const second = sign(2, { test: 2 });
  fail = true;
  await assert.rejects(receiver.receive(second), /runtime failure/);
  assert.equal((await receiver.load()).received.revision, 2);
  assert.equal((await receiver.load()).applied.revision, 1);
  fail = false;
  const reopened = new CellSettingsReceiver(file, adapters);
  await reopened.restoreApplied();
  assert.deepEqual(applications, [1, 1]);
  await assert.rejects(reopened.receive(first), /Stale/);
  await reopened.receive(second);
  assert.deepEqual(applications, [1, 1, 2]);
  await assert.rejects(reopened.receive(sign(3, { wrong: true })), /schema/);
  assert.equal((await reopened.load()).received.revision, 2);
});

test('default receiver enforces assignment schema before saving or applying', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-settings-schema-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = identity();
  const cellKey = identity().publicKey;
  const file = path.join(dir, 'settings.json');
  const applied = [];
  const receiver = new CellSettingsReceiver(file, { controllerKey: controller.publicKey, cellKey,
    apply: async value => applied.push(value) });
  await assert.rejects(receiver.receive(signSettings({ cellKey, revision: 1,
    settings: { shell: 'anything' } }, controller.privateKey)), /Unsupported/);
  assert.equal(await receiver.load(), null);
  assert.equal(applied.length, 0);
  await receiver.receive(signSettings({ cellKey, revision: 1,
    settings: { schema: 1, clients: [] } }, controller.privateKey));
  assert.deepEqual(applied, [{ schema: 1, clients: [] }]);
  const saved = await receiver.load();
  await fs.writeFile(file, JSON.stringify({ ...saved, extra: 'unexpected' }));
  await assert.rejects(receiver.load(), /Invalid settings state/);
});

test('restored authority starts a fresh revision epoch while failed application keeps the previous offline settings', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-settings-epoch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = identity(), cell = identity(), authority = identity();
  const sign = revision => signSettings({ cellKey: cell.publicKey, revision,
    settings: { schema: 1, clients: [] } }, controller.privateKey);
  let epoch = null, failure = false;
  const options = { controllerKey: controller.publicKey, cellKey: cell.publicKey,
    authority: async () => epoch, apply: async () => { if (failure) throw new Error('apply failed'); } };
  const file = path.join(dir, 'settings.json');
  const receiver = new CellSettingsReceiver(file, options);
  await receiver.receive(sign(10));
  epoch = { key: authority.publicKey, generation: 2 };
  failure = true;
  await assert.rejects(receiver.receive(sign(1)), /apply failed/);
  const pending = await receiver.load();
  assert.equal(pending.receivedGeneration, 2);
  assert.equal(pending.appliedGeneration, 0);
  assert.equal(pending.applied.revision, 10);
  failure = false;
  const reopened = new CellSettingsReceiver(file, options);
  assert.deepEqual(await reopened.restoreApplied(), { applied: 10 });
  await reopened.receive(sign(1));
  await reopened.receive(sign(2));
  await assert.rejects(reopened.receive(sign(1)), /Stale/);
  epoch = null;
  await assert.rejects(reopened.receive(sign(99)), /control authority/);
  epoch = { key: identity().publicKey, generation: 2 };
  await assert.rejects(reopened.receive(sign(99)), /control authority/);
  assert.equal((await reopened.load()).applied.revision, 2);
});

test('Linux receiver refuses linked state and a publicly accessible state directory',
  { skip: process.platform === 'win32' }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-settings-private-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const controller = identity();
    const cellKey = identity().publicKey;
    const file = path.join(dir, 'settings.json');
    const receiver = new CellSettingsReceiver(file, { controllerKey: controller.publicKey,
      cellKey, apply: async () => {} });
    await receiver.receive(signSettings({ cellKey, revision: 1,
      settings: { schema: 1, clients: [] } }, controller.privateKey));
    const alias = `${file}.alias`;
    await fs.link(file, alias);
    await assert.rejects(receiver.load(), /Invalid settings file/);
    await fs.unlink(alias);
    const saved = await receiver.load();
    await fs.chmod(dir, 0o755);
    await assert.rejects(receiver.load(), /Private cell settings directory required/);
    await assert.rejects(receiver.save(saved), /Private cell settings directory required/);
  });
