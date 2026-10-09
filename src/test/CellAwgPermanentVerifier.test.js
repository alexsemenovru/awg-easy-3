'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { CellAwgPermanentVerifier, parseHandshake } = require('../lib/CellAwgPermanentVerifier');

const key = () => crypto.randomBytes(32).toString('base64');
function fixture(role = 'cell') {
  const peerPublicKey = key();
  let owned = true, timestamp = 1000, probed = false, calls = 0;
  const verifier = new CellAwgPermanentVerifier({
    path: { interfaceName: 'awgperm8', verifyOwned: async () => owned }, peerPublicKey, role,
    controlAddress: '10.91.8.1', localAddress: '10.91.8.2', controlPort: 53083,
    now: () => 1010_000,
    runner: async (file, args) => {
      assert.equal(file, 'awg');
      assert.deepEqual(args, ['show', 'awgperm8', 'latest-handshakes']);
      calls++;
      return { stdout: `${peerPublicKey}\t${timestamp}\n` };
    },
    probe: async options => {
      probed = true;
      assert.deepEqual(options, { address: '10.91.8.1', port: 53083,
        localAddress: '10.91.8.2' });
      return true;
    },
  });
  return { verifier, setOwned: value => { owned = value; },
    setTimestamp: value => { timestamp = value; },
    probed: () => probed, calls: () => calls };
}

test('cell retirement proof requires owned path, fresh exact peer and bound TCP connection', async () => {
  const f = fixture();
  f.setOwned(false); assert.equal(await f.verifier.verify(), false);
  assert.equal(f.calls(), 0); assert.equal(f.probed(), false);
  f.setOwned(true); f.setTimestamp(800); assert.equal(await f.verifier.verify(), false);
  assert.equal(f.probed(), false);
  f.setTimestamp(1000); assert.equal(await f.verifier.verify(), true);
  assert.equal(f.probed(), true);
});

test('controller proof uses fresh AWG peer handshake without arbitrary TCP probe', async () => {
  const f = fixture('controller');
  assert.equal(await f.verifier.verify(), true);
  assert.equal(f.probed(), false);
  f.setTimestamp(1015); assert.equal(await f.verifier.verify(), false);
});

test('handshake parsing refuses duplicate, malformed or missing peers', () => {
  const peer = key(), other = key();
  assert.equal(parseHandshake(`${other}\t900\n${peer}\t1000\n`, peer), 1000);
  assert.equal(parseHandshake(`${other}\t900\n`, peer), null);
  assert.throws(() => parseHandshake(`${peer}\t1000\n${peer}\t1001`, peer), /Duplicate/);
  assert.throws(() => parseHandshake(`${peer} 1000`, peer), /Invalid/);
  assert.throws(() => parseHandshake(`${peer}\tunexpected`, peer), /Invalid/);
});

test('retirement verifier refuses loopback or public control paths', () => {
  const common = { path: { interfaceName: 'awgperm8', verifyOwned: async () => true },
    peerPublicKey: key(), role: 'cell', localAddress: '10.91.8.2', controlPort: 53083 };
  for (const controlAddress of ['127.0.0.1', '::1', '8.8.8.8']) {
    assert.throws(() => new CellAwgPermanentVerifier({ ...common, controlAddress }), /Invalid/);
  }
});
