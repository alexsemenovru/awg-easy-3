'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyCellDataHandshake } = require('../lib/CellDataHandshake');

const peer = Buffer.alloc(32, 7).toString('base64');
const other = Buffer.alloc(32, 8).toString('base64');
const seconds = 1780000000;
const fixture = text => ({ interfaceName: 'awgdata0', peerPublicKey: peer,
  now: () => seconds * 1000,
  runner: async (file, args, options) => {
    assert.equal(file, 'awg');
    assert.deepEqual(args, ['show', 'awgdata0', 'latest-handshakes']);
    assert.equal(options.maxOutputBytes, 65536);
    return { stdout: text };
  } });

test('fresh authenticated data peer handshake is enough while inner interface stays guarded', async () => {
  assert.equal(await verifyCellDataHandshake(fixture(`${other}\t${seconds - 1}\n${peer}\t${seconds - 3}\n`)), true);
  assert.equal(await verifyCellDataHandshake(fixture(`${peer}\t${seconds - 121}\n`)), false);
  assert.equal(await verifyCellDataHandshake(fixture(`${peer}\t0\n`)), false);
  assert.equal(await verifyCellDataHandshake(fixture(`${other}\t${seconds}\n`)), false);
  assert.equal(await verifyCellDataHandshake(fixture(`${peer}\t${seconds + 3}\n`)), false);
});

test('data handshake errors never become an affirmative link readiness', async () => {
  await assert.rejects(verifyCellDataHandshake({ ...fixture(''),
    runner: async () => { throw new Error('private command detail'); } }),
  /Data AWG handshake inspection failed/);
  await assert.rejects(verifyCellDataHandshake(fixture(`${peer}\t${seconds}\n${peer}\t${seconds}\n`)),
    /Duplicate/);
  await assert.rejects(verifyCellDataHandshake({ ...fixture(''), interfaceName: 'wrong name' }),
    /Invalid data/);
});
