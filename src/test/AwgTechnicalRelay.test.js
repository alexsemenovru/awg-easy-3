'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const dgram = require('node:dgram');
const { identity } = require('../lib/CellRegistration');
const { AwgTechnicalRelay, connectTechnicalRelay, openTechnicalBridge, publicRelayAddress } = require('../lib/AwgTechnicalRelay');

async function fixture(t) {
  const receiver = dgram.createSocket('udp4');
  let delivered = 0;
  receiver.on('message', (bytes, from) => { delivered++; receiver.send(bytes, from.port, from.address); });
  await new Promise(resolve => receiver.bind(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => receiver.close(resolve)));
  const sender = identity();
  const destination = identity();
  const relayIdentity = identity();
  const main = new AwgTechnicalRelay({ identity: destination, kind: 'main',
    controlPort: receiver.address().port, allowedPeer: key => key === sender.publicKey,
    lookup: async () => null });
  await main.start(0, '127.0.0.1');
  t.after(() => main.close());
  const relay = new AwgTechnicalRelay({ identity: relayIdentity, kind: 'cell',
    controlPort: receiver.address().port, allowedPeer: () => false,
    lookup: async (key, kind) => key === destination.publicKey && kind === 'main'
      ? { host: '127.0.0.1', port: main.address().port } : null,
    allowAddress: () => true });
  await relay.start(0, '127.0.0.1');
  t.after(() => relay.close());
  return { sender, destination, relayIdentity, relay, main, delivered: () => delivered };
}

test('an authenticated technical route carries opaque AWG datagrams directly and through one relay', async t => {
  const data = await fixture(t);
  const packet = Buffer.from(Array.from({ length: 1300 }, (_, index) => index % 256));
  for (const [server, key] of [[data.main, data.destination], [data.relay, data.relayIdentity]]) {
    const connection = await connectTechnicalRelay({ host: '127.0.0.1', port: server.address().port,
      serverKey: key.publicKey, identity: data.sender, target: data.destination.publicKey, kind: 'main' });
    try { await connection.write(packet); assert.deepEqual(await connection.read(3000), packet); }
    finally { connection.close(); }
  }
  assert.equal(data.delivered(), 2);
  assert.ok(data.relay.stats.forwardedBytes >= 2600);
});

test('receiver rejects an unregistered origin even through an otherwise valid relay', async t => {
  const data = await fixture(t);
  await assert.rejects(connectTechnicalRelay({ host: '127.0.0.1', port: data.relay.address().port,
    serverKey: data.relayIdentity.publicKey, identity: identity(),
    target: data.destination.publicKey, kind: 'main' }));
  assert.equal(data.delivered(), 0);
});

test('pinned identity and role prevent redirection to a foreign listener', async t => {
  const data = await fixture(t);
  await assert.rejects(connectTechnicalRelay({ host: '127.0.0.1', port: data.main.address().port,
    serverKey: data.relayIdentity.publicKey, identity: data.sender,
    target: data.destination.publicKey, kind: 'main' }), /identity mismatch/);
  await assert.rejects(connectTechnicalRelay({ host: '127.0.0.1', port: data.main.address().port,
    serverKey: data.destination.publicKey, identity: data.sender,
    target: data.destination.publicKey, kind: 'cell' }));
  assert.equal(data.delivered(), 0);
});

test('relay byte budget is shared and private target ranges are rejected by default', async t => {
  const data = await fixture(t);
  assert.equal(data.relay.allow(8192), true);
  assert.equal(data.relay.allow(1), false);
  for (const host of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1',
    '100.64.0.1', '224.0.0.1', '198.51.100.1', '::1']) assert.equal(publicRelayAddress(host), false, host);
  assert.equal(publicRelayAddress('8.8.8.8'), true);
});

test('loopback bridge accepts packets only from its reserved control-AWG socket', async t => {
  const data = await fixture(t);
  const localAwg = dgram.createSocket('udp4');
  await new Promise(resolve => localAwg.bind(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => localAwg.close(resolve)));
  const bridge = await openTechnicalBridge({ localAwgPort: localAwg.address().port,
    host: '127.0.0.1', port: data.relay.address().port,
    serverKey: data.relayIdentity.publicKey, identity: data.sender,
    target: data.destination.publicKey, kind: 'main' });
  t.after(() => bridge.close());
  const expected = Buffer.from('opaque-encrypted-control-packet');
  const returned = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Technical bridge did not return a datagram')), 3000);
    localAwg.once('message', bytes => { clearTimeout(timer); resolve(bytes); });
  });
  localAwg.send(expected, bridge.address.port, '127.0.0.1');
  assert.deepEqual(await returned, expected);
  const foreign = dgram.createSocket('udp4');
  await new Promise(resolve => foreign.send(expected, bridge.address.port, '127.0.0.1', resolve));
  foreign.close();
  await bridge.close();
  assert.equal(data.delivered(), 1);
});
