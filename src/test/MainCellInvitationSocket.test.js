'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { listenInvitationSocket, requestInvitation } = require('../lib/MainCellInvitationSocket');

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

test('control socket rejects a directory readable by other users', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-public-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.chmod(directory, 0o755);
  await assert.rejects(listenInvitationSocket(path.join(directory, 'control.sock'),
    async () => 'x'.repeat(40)), /Private control socket directory required/);
});
