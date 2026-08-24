'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ClientDiagnostics, parseAwgDump } = require('../lib/ClientDiagnostics');

const dump = (rx, tx, handshake = 1_700_000_000) => [
  'private\tserver-public\t51820\toff',
  `peer-public\tpsk\t203.0.113.7:54321\t10.8.0.2/32\t${handshake}\t${rx}\t${tx}\t25`,
].join('\n');

test('parses AWG peer dump without exposing keys in diagnostics', () => {
  const peers = parseAwgDump(dump(100, 200));
  assert.deepEqual(peers.get('peer-public'), {
    endpoint: '203.0.113.7:54321', lastHandshake: 1_700_000_000, receivedBytes: 100, sentBytes: 200,
  });
});

test('computes current upload and download rates from counter deltas', async () => {
  let measuredAt = 1_700_000_010_000;
  let output = dump(100, 200);
  const diagnostics = new ClientDiagnostics({
    store: { load: async () => ({
      server: { interfaceName: 'awg0' },
      clients: [{ id: 'phone', name: 'Phone', enabled: true, publicKey: 'peer-public' }],
    }) },
    runner: async () => ({ stdout: output }),
    now: () => measuredAt,
  });
  assert.deepEqual(await diagnostics.snapshot(), [{
    id: 'phone', state: 'online', downloadBps: 0, uploadBps: 0,
    handshakeAgeSeconds: 10, lastHandshakeAt: '2023-11-14T22:13:20.000Z',
    endpoint: '203.0.113.7:54321', mtu: 1280, persistentKeepalive: '25-35',
  }]);
  measuredAt += 4_000;
  output = dump(500, 1_000);
  const second = (await diagnostics.snapshot())[0];
  assert.equal(second.uploadBps, 100);
  assert.equal(second.downloadBps, 200);
});
