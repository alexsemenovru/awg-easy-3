'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { listenInvitationSocket, requestInvitation, requestBackup, requestCellRemoval } = require('../lib/MainCellInvitationSocket');

test('private control socket issues one bounded invitation and closes cleanly', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-socket-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, 'control.sock');
  let count = 0;
  const listener = await listenInvitationSocket(socketPath, async () => `code-${'x'.repeat(40)}-${++count}`);
  assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
  assert.equal(await requestInvitation(socketPath), `code-${'x'.repeat(40)}-1`);
  assert.equal(await requestInvitation(socketPath), `code-${'x'.repeat(40)}-2`);
  await assert.rejects(listenInvitationSocket(socketPath, async () => 'x'), /already in use/);
  await listener.close();
  await assert.rejects(fs.lstat(socketPath), { code: 'ENOENT' });
});

test('private socket queues only a validated Cell identifier, without an arbitrary command or path', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-removal-socket-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, 'control.sock'); let received;
  const listener = await listenInvitationSocket(socketPath, async () => 'unused', {
    removeCell: async id => { received = id; return { queued: true, affectedClients: 2 }; } });
  t.after(() => listener.close());
  assert.deepEqual(await requestCellRemoval(socketPath, 'a'.repeat(32)), { queued: true, affectedClients: 2 });
  assert.equal(received, 'a'.repeat(32));
  await assert.rejects(requestCellRemoval(socketPath, '../other'), /identifier/);
});

test('private socket carries a bounded encrypted backup separately from invitations', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-backup-socket-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, 'control.sock');
  let count = 0;
  const value = { id: Buffer.alloc(16, 1).toString('base64url'), archive: Buffer.alloc(20000, 2).toString('base64'),
    recoveryKey: `AWG3-B1-${Buffer.alloc(32, 3).toString('base64url')}`, generation: 1, createdAt: 1000 };
  const listener = await listenInvitationSocket(socketPath, async () => { count++; return 'x'.repeat(40); },
    { createBackup: async () => value });
  t.after(() => listener.close());
  assert.deepEqual(await requestBackup(socketPath), value);
  assert.equal(count, 0);
  assert.equal(await requestInvitation(socketPath), 'x'.repeat(40));
  value.archive = 'malformed-base64!';
  await assert.rejects(requestBackup(socketPath), /Invalid Main backup/);
});

test('control socket rejects a directory readable by other users', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-public-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.chmod(directory, 0o755);
  await assert.rejects(listenInvitationSocket(path.join(directory, 'control.sock'),
    async () => 'x'.repeat(40)), /Private control socket directory required/);
});
