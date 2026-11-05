'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { EventEmitter, once } = require('node:events');
const { identity } = require('../lib/CellRegistration');
const { createCellLocator, verifyCellLocator } = require('../lib/CellDhtLocator');
const { DhtBudgetSocket } = require('../lib/DhtBudgetSocket');
const { DhtContactCache } = require('../lib/DhtContactCache');
const { DhtDiscoveryRuntime, verifyMutable } = require('../lib/DhtDiscoveryRuntime');
const { startDhtDiscovery } = require('../lib/DhtDiscoverySupervisor');
const { openNodeDiscovery } = require('../lib/NodeDiscoveryService');

const temporary = async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-dht-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};
const signed = options => {
  const item = createCellLocator(options);
  const bstring = bytes => Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
  const data = Buffer.concat([Buffer.from('4:salt'), bstring(item.salt),
    Buffer.from(`3:seqi${item.seq}e1:v`), bstring(item.v)]);
  return { ...item, sig: item.sign(data) };
};

test('DHT locator binds Main versus Cell role under a pinned signing key', () => {
  const signer = identity();
  const item = signed({ privateKey: signer.privateKey, kind: 'main',
    host: '203.0.113.1', port: 49033, seq: 1 });
  assert.equal(verifyCellLocator(item, { cellKey: signer.publicKey, kind: 'main' }).port, 49033);
  assert.throws(() => verifyCellLocator(item, { cellKey: signer.publicKey, kind: 'cell' }));
  assert.throws(() => createCellLocator({ privateKey: signer.privateKey, kind: 'other',
    host: '203.0.113.1', port: 49033, seq: 1 }));
});

test('UDP budgets drop oversized and excess traffic before parsing, with no pending queue', async () => {
  let now = 0;
  let sent = 0;
  let received = 0;
  const underlying = new EventEmitter();
  underlying.send = () => { sent++; };
  const socket = new DhtBudgetSocket({ socket: underlying, packetsPerSecond: 2,
    bytesPerSecond: 4096, clock: () => now });
  socket.on('message', () => { received++; });
  for (let count = 0; count < 5; count++) underlying.emit('message', Buffer.alloc(100), {});
  assert.equal(received, 2);
  let rejected = 0;
  for (let count = 0; count < 5; count++) socket.send(Buffer.alloc(100), 0, 100, 1, '127.0.0.1', error => { if (error) rejected++; });
  await Promise.resolve();
  assert.equal(sent, 2);
  assert.equal(rejected, 3);
  underlying.emit('message', Buffer.alloc(4096), {});
  assert.equal(received, 2);
  now = 1000;
  underlying.emit('message', Buffer.alloc(100), {});
  assert.equal(received, 3);
  assert.deepEqual(socket.stats(), { receivedBytes: 300, sentBytes: 200, droppedIn: 4, droppedOut: 3 });
});

test('DHT cache persists only bounded contacts, never foreign values or secrets', async t => {
  const directory = await temporary(t);
  const cache = new DhtContactCache(directory);
  assert.deepEqual(await cache.read(), []);
  await cache.write(Array.from({ length: 300 }, (_, index) => ({ host: '127.0.0.1', port: 1000 + index,
    privateKey: 'not-persisted', v: 'not-persisted' })));
  assert.equal((await cache.read()).length, 128);
  await cache.write([]);
  assert.equal((await cache.read()).length, 128);
  assert.doesNotMatch(await fs.readFile(cache.file, 'utf8'), /not-persisted|privateKey/);
  await fs.writeFile(cache.file, JSON.stringify({ version: 1, nodes: [], injected: true }));
  await assert.rejects(cache.read(), /Invalid DHT cache/);
});

test('three actual UDP nodes exchange signed locators and restart using cached contacts only', { timeout: 30000 }, async t => {
  const { default: DHT } = await import('bittorrent-dht');
  const directory = await temporary(t);
  const seed = new DHT({ bootstrap: false, verify: verifyMutable });
  t.after(() => new Promise(resolve => seed.destroy(resolve)));
  const listening = once(seed, 'listening');
  seed.listen(0, '127.0.0.1');
  await listening;
  const mainIdentity = identity();
  const cellIdentity = identity();
  const runtime = (name, kind, signer, bootstrap = false) => new DhtDiscoveryRuntime({
    directory: path.join(directory, name), identity: signer, kind,
    endpointHost: '127.0.0.1', port: 0, bindAddress: '127.0.0.1', bootstrap,
    newDht: options => new DHT(options),
  });
  const main = runtime('main', 'main', mainIdentity);
  const cell = runtime('cell', 'cell', cellIdentity);
  t.after(() => Promise.all([main.close(), cell.close()]));
  main.setPeers([{ publicKey: cellIdentity.publicKey, kind: 'cell' }]);
  cell.setPeers([{ publicKey: mainIdentity.publicKey, kind: 'main' }]);
  await main.start(); await cell.start();
  for (const service of [main, cell]) {
    const joined = once(service.dht, 'node');
    service.dht.addNode({ host: '127.0.0.1', port: seed.address().port });
    await joined;
  }
  await main.tick();
  await cell.tick();
  await main.tick();
  assert.equal(cell.contact(mainIdentity.publicKey).port, main.dht.address().port);
  assert.equal(main.contact(cellIdentity.publicKey).port, cell.dht.address().port);
  assert.equal(main.status().locatedPeers, 1);
  assert.doesNotMatch(JSON.stringify(main.status()), /127\.0\.0\.1|privateKey|publicKey/);
  main.setPeers([]);
  assert.equal(main.contact(cellIdentity.publicKey), null);
  await cell.close();
  await new Promise(resolve => seed.destroy(resolve));
  const restored = runtime('cell', 'cell', cellIdentity, []);
  t.after(() => restored.close());
  restored.setPeers([{ publicKey: mainIdentity.publicKey, kind: 'main' }]);
  await restored.start();
  await restored.tick();
  assert.ok(restored.contact(mainIdentity.publicKey), JSON.stringify({
    restored: restored.status(), contacts: (await restored.cache.read()).length,
    mainRecords: main.dht._values.length, main: main.status(),
  }));
  assert.equal(restored.contact(mainIdentity.publicKey).port, main.dht.address().port);
});

test('discovery polls only identities already registered with this Main', async () => {
  const main = identity();
  const cell = identity();
  let config;
  const status = await openNodeDiscovery({ role: 'main',
    config: { stateDirectory: path.resolve('main-state'), endpointHost: '203.0.113.1', dhtPort: 49033 },
    host: { identityStore: { load: async () => main }, bootstrapStore: { read: async () => ({ invitations: [
      { status: 'pending', phase: 'closed', cellKey: identity().publicKey },
      { status: 'consumed', phase: 'closed', cellKey: cell.publicKey },
      { status: 'consumed', phase: 'ready', cellKey: identity().publicKey },
    ] }) } },
    start: options => { config = options; return { close() {} }; } });
  assert.equal(typeof status.close, 'function');
  assert.deepEqual(await config.peers(), [{ publicKey: cell.publicKey, kind: 'cell' }]);
  const unavailable = await openNodeDiscovery({ role: 'cell', config: {}, host: {} });
  assert.deepEqual(unavailable.status(), { state: 'unavailable' });
});

test('worker failure cannot stop AWG, and close cancels retries without exposing identities', async () => {
  const worker = new EventEmitter();
  const messages = [];
  worker.postMessage = message => {
    messages.push(message.type);
    if (message.type === 'stop') queueMicrotask(() => worker.emit('exit', 0));
  };
  const service = startDhtDiscovery({ directory: path.resolve('dht-state'),
    identity: identity(), kind: 'cell', endpointHost: '203.0.113.1', port: 49033,
    newWorker: (_file, options) => {
      assert.equal(options.resourceLimits.maxOldGenerationSizeMb, 32);
      return worker;
    } });
  worker.emit('error', new Error('private endpoint diagnostic'));
  assert.deepEqual(service.status(), { state: 'unavailable' });
  await service.close();
  assert.ok(messages.includes('stop'));
  assert.deepEqual(service.status(), { state: 'stopped' });
});

test('real isolated worker starts with its memory limit and closes without public bootstrap', { timeout: 15000 }, async t => {
  const directory = await temporary(t);
  const service = startDhtDiscovery({ directory, identity: identity(), kind: 'cell',
    endpointHost: '127.0.0.1', port: 0, bindAddress: '127.0.0.1', bootstrap: false });
  t.after(() => service.close());
  const deadline = Date.now() + 7000;
  while (service.status().state === 'starting' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(service.status().state, 'listening');
  assert.equal(service.status().knownPeers, 0);
  await service.close();
  assert.equal(service.status().state, 'stopped');
});
