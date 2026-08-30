'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ClientDiagnostics, parseAwgDump } = require('../lib/ClientDiagnostics');

const epoch = 1_700_000_000;
const peer = (key, rx = 100, tx = 200, handshake = epoch) =>
  `${key}\tpsk\t203.0.113.7:54321\t10.8.0.2/32\t${handshake}\t${rx}\t${tx}\t25`;
const dump = (...peers) => ['private\tserver-public\t51820\toff', ...peers].join('\n');
const client = (id) => ({ id, enabled: true, publicKey: id });
const fixture = () => {
  const value = {
    wall: (epoch + 10) * 1000, time: 1000, calls: 0, output: dump(peer('phone')),
    state: { server: { interfaceName: 'awg0' }, clients: [client('phone')] },
    read: async () => ({ stdout: value.output }),
  };
  value.advance = (ms = 4000) => { value.time += ms; value.wall += ms; };
  value.diagnostics = new ClientDiagnostics({
    store: { load: async () => value.state },
    runner: async () => { value.calls += 1; return value.read(); },
    now: () => value.wall,
    monotonicNow: () => value.time,
  });
  value.snapshot = () => value.diagnostics.snapshot();
  return value;
};

test('first sample is measuring, not an invented zero rate', async () => {
  const [item] = await fixture().snapshot();
  assert.equal(item.downloadBps, null);
  assert.equal(item.uploadBps, null);
  assert.equal(item.sampleIntervalSeconds, null);
});

test('a switched-away profile becomes zero-rate while its recent handshake can persist', async () => {
  const f = fixture();
  f.state.clients = [client('home-admin'), client('honor-50')];
  f.output = dump(peer('home-admin'), peer('honor-50', 0, 0, 0));
  await f.snapshot();
  f.advance();
  f.output = dump(peer('honor-50', 900, 1200, epoch + 14), peer('home-admin'));
  const [home, honor] = await f.snapshot();
  assert.equal(home.state, 'online'); // Means recent handshake, not guaranteed connectivity.
  assert.equal(home.downloadBps, 0);
  assert.equal(home.uploadBps, 0);
  assert.equal(honor.uploadBps, 225);
  assert.equal(honor.downloadBps, 300);
  f.advance(151_000);
  assert.equal((await f.snapshot())[0].state, 'offline');
});

test('server-only outgoing packets are reported without inventing client replies', async () => {
  const f = fixture();
  await f.snapshot();
  f.advance();
  f.output = dump(peer('phone', 100, 1000));
  const [item] = await f.snapshot();
  assert.equal(item.downloadBps, 200);
  assert.equal(item.uploadBps, 0);
});

test('concurrent viewers share one in-flight command and the same sample', async () => {
  const f = fixture();
  let finish;
  f.read = () => new Promise((resolve) => { finish = resolve; });
  const first = f.snapshot();
  const second = f.snapshot();
  await new Promise(setImmediate);
  assert.equal(f.calls, 1);
  finish({ stdout: f.output });
  assert.strictEqual(await first, await second);
  f.advance(100);
  assert.strictEqual(await f.snapshot(), await first);
  assert.equal(f.calls, 1);
});

test('changed client state invalidates the short cache and disabled peers show no traffic', async () => {
  const f = fixture();
  await f.snapshot();
  f.state.clients[0].enabled = false;
  f.output = dump(peer('phone', 900, 1300));
  const [item] = await f.snapshot();
  assert.equal(item.state, 'disabled');
  assert.equal(item.downloadBps, 0);
  assert.equal(item.uploadBps, 0);
  assert.equal(f.diagnostics.previous.size, 0);
});

test('counter resets discard both rates and start a new baseline', async () => {
  const f = fixture();
  await f.snapshot();
  f.advance();
  f.output = dump(peer('phone', 50, 1000));
  const [reset] = await f.snapshot();
  assert.equal(reset.downloadBps, null);
  assert.equal(reset.uploadBps, null);
  f.advance();
  f.output = dump(peer('phone', 450, 1800));
  const [next] = await f.snapshot();
  assert.equal(next.downloadBps, 200);
  assert.equal(next.uploadBps, 100);
});

for (const absent of ['missing peer', 'removed client']) {
  test(`forgets the baseline of a ${absent}`, async () => {
    const f = fixture();
    await f.snapshot();
    f.advance();
    if (absent === 'missing peer') f.output = dump();
    else f.state.clients = [];
    await f.snapshot();
    assert.equal(f.diagnostics.previous.size, 0);
    f.advance();
    f.state.clients = [client('phone')];
    f.output = dump(peer('phone', 900, 1300));
    assert.equal((await f.snapshot())[0].downloadBps, null);
  });
}

test('failed or stale measurements do not become current speeds on recovery', async () => {
  const f = fixture();
  await f.snapshot();
  f.advance();
  f.read = async () => { throw new Error('AWG unavailable'); };
  await assert.rejects(f.snapshot(), /AWG unavailable/);
  f.read = async () => ({ stdout: dump(peer('phone', 900, 1300)) });
  assert.equal((await f.snapshot())[0].downloadBps, null);
  f.advance(60_000);
  assert.equal((await f.snapshot())[0].downloadBps, null);
});

test('rate measurement uses a monotonic clock and is unaffected by wall-clock correction', async () => {
  const f = fixture();
  await f.snapshot();
  f.advance();
  f.wall -= 3_600_000;
  f.output = dump(peer('phone', 500, 1000));
  assert.equal((await f.snapshot())[0].downloadBps, 200);
});

test('timestamps samples after the AWG command completes', async () => {
  const f = fixture();
  await f.snapshot();
  f.advance();
  f.read = async () => { f.advance(2000); return { stdout: dump(peer('phone', 700, 1400)) }; };
  const [item] = await f.snapshot();
  assert.equal(item.sampleIntervalSeconds, 6);
  assert.equal(item.downloadBps, 200);
});

test('equal or backward sample times cannot produce rate spikes', async () => {
  const f = fixture();
  await f.snapshot();
  f.time -= 100;
  f.output = dump(peer('phone', 900, 1300));
  assert.equal((await f.snapshot())[0].downloadBps, null);
});

test('diagnostic parser fails closed on incomplete or invalid counters without exposing dump secrets', () => {
  for (const output of ['', 'secret', dump(peer('phone', 'NaN')), dump(peer('phone', -1)),
    dump(peer('phone', 'Infinity')), dump(peer('phone', 1, 2, 'NaN'))]) {
    assert.throws(() => parseAwgDump(output), (error) =>
      /AWG dump/.test(error.message) && !error.message.includes('private') && !error.message.includes('psk'));
  }
});
