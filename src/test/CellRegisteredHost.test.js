'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { openRegisteredCellHost } = require('../lib/CellRegisteredHost');
const { signSettings } = require('../lib/CellSettings');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const options = () => ({ stateDirectory: path.resolve('cell-state'),
  runtimeDirectory: path.resolve('cell-runtime'),
  connectionStore: { read: async () => ({ status: 'registered' }) },
  identityStore: { load: async () => ({}) }, bootstrap: {},
  temporaryInterfaceName: 'awgjoin0', server: { interfaceName: 'awgcell0' } });

test('registered Cell host uses one lock for boot, join and every settings poll', async () => {
  const input = options(), events = [];
  const settings = { adapter: { prepareBoot: async () => { events.push(['guard']); } },
    receiver: { restoreApplied: async () => ({}) } };
  const permanent = { recoverBoot: async value => { events.push(['boot', value]); return 'booted'; },
    join: async value => { events.push(['join', value]); return 'joined'; },
    syncSettings: async value => { events.push(['sync', value]); return 'synced'; } };
  const host = await openRegisteredCellHost({ ...input,
    openSettings: async value => { events.push(['settings-open', value]); return settings; },
    openPermanent: value => { events.push(['permanent-open', value]); return permanent; },
    withLock: async ({ lockPath, work }) => {
      assert.equal(lockPath, path.join(input.stateDirectory, 'install.lock'));
      events.push(['lock-enter']);
      try { return await work(); } finally { events.push(['lock-exit']); }
    } });
  await host.protectUserTraffic();
  assert.equal(await host.recoverBoot({ test: 1 }), 'booted');
  assert.equal(await host.join({ test: 2 }), 'joined');
  assert.equal(await host.syncSettings(), 'synced');
  let poller;
  poller = host.createPoller({ onStatus: status => {
    if (status.state === 'connected') poller.controller.abort(); } });
  await poller.start();
  assert.equal(events.filter(item => item[0] === 'lock-enter').length, 5);
  assert.equal(events.filter(item => item[0] === 'lock-exit').length, 5);
  assert.ok(events.findIndex(item => item[0] === 'guard')
    < events.findIndex(item => item[0] === 'boot'));
  assert.deepEqual(events.filter(item => ['boot', 'join', 'sync'].includes(item[0]))
    .map(item => item[0]), ['boot', 'join', 'sync', 'sync']);
  assert.equal(events[0][1].stateDirectory, path.join(input.stateDirectory, 'settings'));
  assert.equal(events[1][1].stateDirectory, path.join(input.stateDirectory, 'permanent'));
  assert.equal(events[1][1].clientRuntime, settings.adapter);
});

test('registered Cell host rejects missing absolute state and identity', async () => {
  await assert.rejects(openRegisteredCellHost({ ...options(), stateDirectory: 'relative' }),
    /Registered Cell host dependencies/);
  await assert.rejects(openRegisteredCellHost({ ...options(), identityStore: null }),
    /Registered Cell host dependencies/);
});

test('registered Cell changes GeoIP under the same lock and rolls back failed commit', async () => {
  const identity = crypto.generateKeyPairSync('ed25519');
  const controllerKey = identity.publicKey.export({ format: 'jwk' }).x;
  const cellKey = Buffer.alloc(32, 4).toString('base64url');
  const settings = { schema: 1, clients: [{ id: 'one',
    publicKey: Buffer.alloc(32, 5).toString('base64'), address4: '10.88.8.2',
    networkGroup: 'guest', ipv4Enabled: true, ipv6Enabled: false,
    geoPolicy: { mode: 'block', countries: ['RU'] } }] };
  const applied = signSettings({ cellKey, revision: 1, settings },
    identity.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  let previous = { RU: { ipv4: ['198.51.100.1/32'], ipv6: [] } };
  const next = { RU: { ipv4: ['198.51.100.2/32'], ipv6: [] } };
  const events = [];
  const host = await openRegisteredCellHost({ ...options(),
    server: { interfaceName: 'awgcell0', wanInterface: 'eth0',
      privateKey: Buffer.alloc(32, 6).toString('base64'), listenPort: 51830,
      address4: '10.88.8.1', ipv4Subnet: '10.88.8.0/24',
      profile: generateOfficialProfile() },
    openSettings: async () => ({
      receiver: { trust: { controllerKey, cellKey }, load: async () => ({ applied }),
        restoreApplied: async () => ({}) },
      adapter: { geoDatabase: async () => previous,
        apply: async (_payload, value) => { events.push(value.geoDatabase); },
        prepareBoot: async () => {} },
    }),
    openPermanent: () => ({ recoverBoot: async () => {}, join: async () => {},
      syncSettings: async () => {} }),
    withLock: async ({ work }) => work(),
  });
  assert.equal(await host.requiresGeoDatabase(), true);
  await host.installGeoSnapshot({ database: next }, async () => { events.push('commit'); });
  assert.deepEqual(events, [next, 'commit']);
  events.length = 0;
  await assert.rejects(host.installGeoSnapshot({ database: next }, async () => {
    events.push('commit'); throw new Error('disk full');
  }), /disk full/);
  assert.deepEqual(events, [next, 'commit', previous]);
  events.length = 0;
  await assert.rejects(host.installGeoSnapshot({ database: { US: {} } }, async () => {
    events.push('commit');
  }), /GeoIP country unavailable/);
  assert.deepEqual(events, []);
  previous = {};
  await host.installGeoSnapshot({ database: next }, async () => { events.push('commit'); });
  assert.deepEqual(events, ['commit']);
});
