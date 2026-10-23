'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const test = require('node:test');
const { startCellService, syncCellOnce } = require('../lib/CellService');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const config = () => ({ stateDirectory: path.resolve('cell-state'),
  runtimeDirectory: path.resolve('cell-runtime'), interfaceName: 'awgboot0',
  resources: { interfaceNames: ['awgboot0', 'awgctl0', 'awguser0'], udpPorts: [51830] } });
const bootstrapHost = () => ({ connectionStore: { read: async () => ({ status: 'registered',
  permanent: { privateKey: 'control-key' } }) }, identityStore: {}, bootstrap: {} });
const newDataIdentity = () => ({ ensure: async () => ({ privateKey: 'data-private',
  publicKey: Buffer.alloc(32, 12).toString('base64') }) });

test('Cell service restores signed state before polling and closes poller only', async () => {
  const order = [];
  let args;
  let complete;
  const running = new Promise(resolve => { complete = resolve; });
  const service = await startCellService({ config: config(), newDataIdentity,
    bootstrapHost: bootstrapHost(),
    newStore: (filename, reserved) => {
      assert.equal(filename, path.join(config().stateDirectory, 'user-config.json'));
      assert.deepEqual(reserved, { interfaceName: 'awguser0', listenPort: 51830 });
      return { read: async () => ({ server: { interfaceName: 'awguser0' } }) };
    },
    newGeoUpdater: () => ({ current: { database: { RU: { ipv4: [], ipv6: [] } } },
      load: async () => { order.push('geo'); },
      start: () => { order.push('geo-start'); },
      stop: async () => { order.push('geo-stop'); } }),
    openRegistered: async supplied => {
      args = supplied;
      order.push('registered');
      return { protectUserTraffic: async () => { order.push('guard'); },
        recoverBoot: async () => { order.push('restore'); return { configured: true }; },
        createPoller: () => ({ start: () => { order.push('poll'); return running; },
          stop: async () => { order.push('stop'); complete(); } }) };
    } });
  assert.equal(service.status, 'serving');
  assert.deepEqual(await args.geoDatabase(), { RU: { ipv4: [], ipv6: [] } });
  assert.deepEqual(order, ['geo', 'registered', 'guard', 'restore', 'poll', 'geo-start']);
  await service.close();
  assert.deepEqual(order, ['geo', 'registered', 'guard', 'restore', 'poll', 'geo-start', 'geo-stop', 'stop']);
});

test('Cell service refuses missing user config and incomplete permanent path', async () => {
  let registered = false;
  await assert.rejects(startCellService({ config: config(), bootstrapHost: bootstrapHost(), newDataIdentity,
    newStore: () => ({ read: async () => null }),
    openRegistered: async () => { registered = true; } }), /not installed/);
  assert.equal(registered, false);
  await assert.rejects(startCellService({ config: config(), bootstrapHost: bootstrapHost(), newDataIdentity,
    newStore: () => ({ read: async () => ({ server: {} }) }),
    newGeoUpdater: () => ({ current: null, load: async () => null, refresh: async () => null }),
    openRegistered: async () => ({ protectUserTraffic: async () => {},
      requiresGeoDatabase: async () => true,
      recoverBoot: async () => ({ configured: false }) }),
  }), /not configured/);
  await assert.rejects(startCellService({ config: config(), bootstrapHost: bootstrapHost(), newDataIdentity,
    newStore: () => ({ read: async () => ({ server: { privateKey: 'control-key' } }) }),
    openRegistered: async () => { registered = true; },
  }), /distinct user AWG key/);
});

test('Cell service refreshes absent GeoIP cache before restoring signed filter', async () => {
  const order = [];
  const geo = { current: null,
    load: async () => { order.push('load'); },
    refresh: async () => { order.push('refresh'); geo.current = { database: { RU: {} } }; },
    start: () => { order.push('start'); }, stop: async () => { order.push('stop'); } };
  const service = await startCellService({ config: config(), bootstrapHost: bootstrapHost(), newDataIdentity,
    newStore: () => ({ read: async () => ({ server: {} }) }),
    newGeoUpdater: () => geo,
    openRegistered: async () => ({
      protectUserTraffic: async () => { order.push('guard'); },
      requiresGeoDatabase: async () => { order.push('needs-geo'); return true; },
      recoverBoot: async () => { order.push('restore');
        assert.deepEqual(geo.current.database, { RU: {} });
        return { configured: true }; },
      createPoller: () => ({ start: () => { order.push('poll'); return new Promise(() => {}); },
        stop: async () => { order.push('poll-stop'); } }),
    }) });
  assert.deepEqual(order, ['load', 'guard', 'needs-geo', 'refresh', 'restore', 'poll', 'start']);
  await service.close();
  assert.deepEqual(order.slice(-2), ['stop', 'poll-stop']);
});

test('one-shot Cell sync restores boot, applies signed settings, and opens no poller', async () => {
  const events = [];
  const result = await syncCellOnce({ config: config(), bootstrapHost: bootstrapHost(), newDataIdentity,
    newStore: () => ({ read: async () => ({ server: {} }) }),
    newGeoUpdater: () => ({ current: { database: {} }, load: async () => events.push('geo') }),
    openRegistered: async () => ({
      protectUserTraffic: async () => { events.push('guard'); },
      recoverBoot: async () => { events.push('boot'); return { configured: true }; },
      syncSettings: async () => { events.push('sync'); return { status: 'applied', revision: 2 }; },
      createPoller: () => { throw new Error('must not poll'); },
    }) });
  assert.deepEqual(result, { status: 'applied', revision: 2 });
  assert.deepEqual(events, ['geo', 'guard', 'boot', 'sync']);
});

test('Cell service derives a public entry descriptor without exposing its private AWG key', async () => {
  let supplied;
  const profile = generateOfficialProfile();
  await syncCellOnce({ config: { ...config(), endpointHost: '198.51.100.4' }, newDataIdentity,
    bootstrapHost: bootstrapHost(),
    newStore: () => ({ read: async () => ({ server: { privateKey: 'cell-private',
      listenPort: 51830, address4: '10.64.0.1', ipv4Subnet: '10.64.0.0/24', profile } }) }),
    keyManager: { derivePublicKey: async privateKey => {
      assert.equal(privateKey, 'cell-private');
      return Buffer.alloc(32, 4).toString('base64');
    } },
    newGeoUpdater: () => ({ current: { database: {} }, load: async () => {} }),
    openRegistered: async args => { supplied = args; return {
      protectUserTraffic: async () => {}, recoverBoot: async () => ({ configured: true }),
      syncSettings: async () => ({ status: 'no-settings' }),
    }; },
  });
  assert.equal(supplied.userDescriptor.endpointHost, '198.51.100.4');
  assert.equal(supplied.userDescriptor.serverPublicKey, Buffer.alloc(32, 4).toString('base64'));
  assert.equal(supplied.dataPublicKey, Buffer.alloc(32, 12).toString('base64'));
  assert.equal(JSON.stringify(supplied.userDescriptor).includes('cell-private'), false);
});

test('Cell sync pins a signed offer and stages a separate guarded AWG plan', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-service-data-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = n => Buffer.alloc(32, n).toString('base64');
  const server = { privateKey: key(4), ipv4Subnet: '10.88.0.0/24',
    interfaceName: 'awguser0', listenPort: 51830 };
  const offer = { version: 1, presharedKey: key(3), descriptor: {
    version: 1, slot: 0, endpointHost: '198.51.100.4', endpointPort: 53000,
    controllerAddress4: '10.252.0.1', cellAddress4: '10.252.0.2',
    controllerPublicKey: key(2), controllerClientSubnet4: '10.8.0.0/24',
    cellClientSubnet4: '10.88.0.0/24', profile: generateOfficialProfile() } };
  let staged;
  await syncCellOnce({ config: { ...config(), stateDirectory: root },
    bootstrapHost: bootstrapHost(),
    newStore: () => ({ read: async () => ({ server }) }),
    newDataIdentity: () => ({ ensure: async () => ({ privateKey: key(5), publicKey: key(6) }) }),
    newDataDeployment: options => ({ ...options, store: { read: async () => null } }),
    stageData: async ({ expected }) => { staged = expected; return { guarded: true }; },
    newGeoUpdater: () => ({ current: { database: {} }, load: async () => {} }),
    openRegistered: async supplied => ({
      protectUserTraffic: async () => {},
      recoverBoot: async () => ({ configured: true }),
      syncSettings: async () => { await supplied.receiveDataOffer(offer);
        return { status: 'no-settings' }; },
    }),
  });
  assert.equal(staged.plan.spec.owner.interfaceName, 'awgdata0');
  assert.equal(staged.guardTable, 'awg_easy_3_data_guard_cell');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'received-data-offer.json'),
    'utf8')).descriptor.controllerAddress4, '10.252.0.1');
});
