'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sealBackup, openBackup } = require('../lib/BackupEnvelope');

test('each backup gets a separate recovery key and restores only its exact archive', () => {
  const snapshot = Buffer.from(JSON.stringify({ serverPrivateKey: 'private material',
    clients: [{ name: 'Миша', key: 'client secret' }] }));
  const first = sealBackup(snapshot), second = sealBackup(snapshot);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.recoveryKey, second.recoveryKey);
  assert.ok(!first.archive.includes(Buffer.from('private material')));
  assert.deepEqual(openBackup(first.archive, first.recoveryKey), snapshot);
  assert.deepEqual(openBackup(second.archive, second.recoveryKey), snapshot);
  assert.throws(() => openBackup(first.archive, second.recoveryKey), /Invalid backup/);
});

test('archive metadata and ciphertext are authenticated; malformed keys fail closed', () => {
  const result = sealBackup(Buffer.from('state'));
  const tampered = JSON.parse(result.archive);
  tampered.id = sealBackup(Buffer.from('other')).id;
  assert.throws(() => openBackup(Buffer.from(JSON.stringify(tampered)), result.recoveryKey),
    /Invalid backup/);
  tampered.id = JSON.parse(result.archive).id;
  tampered.ciphertext = Buffer.from('wrong').toString('base64url');
  assert.throws(() => openBackup(Buffer.from(JSON.stringify(tampered)), result.recoveryKey),
    /Invalid backup/);
  assert.throws(() => openBackup(result.archive, `${result.recoveryKey}A`), /Invalid backup/);
  assert.throws(() => openBackup(Buffer.concat([result.archive, Buffer.from(' ')]),
    result.recoveryKey), /Invalid backup/);
});

test('backup envelope enforces the bounded configuration snapshot size', () => {
  assert.throws(() => sealBackup(Buffer.alloc(0)), /size/);
  assert.throws(() => sealBackup(Buffer.alloc(8 * 1024 * 1024 + 1)), /size/);
  const max = sealBackup(Buffer.alloc(8 * 1024 * 1024, 7));
  assert.equal(openBackup(max.archive, max.recoveryKey).length, 8 * 1024 * 1024);
});
