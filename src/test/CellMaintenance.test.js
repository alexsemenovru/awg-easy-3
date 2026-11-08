'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { identity } = require('../lib/CellRegistration');
const { MainCellMaintenance, newer, verifyCommand, receiptFor, verifyReceipt,
  verifyHostRequest, receiptAckFor, verifyReceiptAck, sign } = require('../lib/CellMaintenance');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const controller = identity(), cell = identity();
  let authority = identity();
  const options = { controller, cellKey: cell.publicKey, authority: async () => authority,
    endpointHost: 'example.com', version: '1.2.3' };
  const file = path.join(directory, 'journal');
  return { controller, cell, store: new MainCellMaintenance(file, options),
    reopen: () => new MainCellMaintenance(file, options),
    rotate: () => { authority = identity(); }, trust: () => ({ controllerKey: controller.publicKey,
      cellKey: cell.publicKey, authorityKey: authority.publicKey }) };
}
test('updates are forward only and completion requires a report from the new running version', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.poll('1.2.3'), null);
  assert.equal(await f.store.poll('1.2.4'), null);
  const command = await f.store.poll('1.2.2');
  assert.equal(command.action, 'update'); assert.equal(command.targetVersion, '1.2.3');
  assert.deepEqual(verifyCommand(command, f.trust()), command);
  assert.deepEqual(await f.reopen().poll('1.2.2'), command);
  assert.equal(await f.store.poll('1.2.3'), null);
  assert.deepEqual(await f.store.status(), { version: '1.2.3', action: null,
    targetVersion: null, completed: false, matchesMain: true });
  for (const value of ['1.2.3-beta', '1.2', '01.2.3', null]) assert.throws(() => newer(value, '1.2.3'));
});
test('removal remains pending offline, supersedes update, and only accepts the exact signed receipt', async t => {
  const f = await fixture(t);
  const update = await f.store.poll('1.0.0');
  const command = await f.store.remove();
  assert.equal(command.action, 'remove'); assert.notEqual(command.id, update.id);
  assert.deepEqual(await f.reopen().remove(), command);
  assert.deepEqual(await f.store.poll('1.2.3'), command);
  await assert.rejects(f.store.accept(receiptFor(update, f.cell)), /differs/);
  await assert.rejects(f.store.accept(receiptFor(command, identity())), /signature/);
  const receipt = receiptFor(command, f.cell);
  assert.deepEqual(await f.store.accept(receipt), { accepted: true, commandId: command.id });
  assert.equal(await f.reopen().poll('1.2.3'), null);
  assert.equal((await f.store.status()).completed, false);
  await f.store.finishRemoval();
  assert.equal((await f.store.status()).completed, true);
  assert.deepEqual(await f.store.accept(receipt), { accepted: true, commandId: command.id });
});
test('restored authority rotates a pending command and rejects the old authority receipt', async t => {
  const f = await fixture(t), old = await f.store.remove();
  f.rotate(); const fresh = await f.store.poll('1.2.3');
  assert.notEqual(fresh.id, old.id);
  assert.throws(() => verifyCommand(old, f.trust()), /Invalid maintenance command/);
  await assert.rejects(f.store.accept(receiptFor(old, f.cell)), /differs/);
  await f.store.accept(receiptFor(fresh, f.cell));
});
test('host requests require both Main authorization and the pinned Cell signature', async t => {
  const f = await fixture(t), command = await f.store.remove();
  const body = { version: 1, command };
  const request = sign(body, f.cell.privateKey, 'network-maintenance-host/v1');
  verifyHostRequest(request, f.trust());
  assert.throws(() => verifyHostRequest(sign(body, identity().privateKey,
    'network-maintenance-host/v1'), f.trust()), /signature/);
  assert.throws(() => verifyHostRequest({ ...request, command: { ...command,
    action: 'update', targetVersion: '9.0.0' } }, f.trust()), /signature/);
  assert.throws(() => verifyReceipt({ ...receiptFor(command, f.cell), extra: true }, command), /differs/);
  verifyReceiptAck(receiptAckFor(command, f.controller), command);
  assert.throws(() => verifyReceiptAck(receiptAckFor(command, f.cell), command), /signature/);
});
