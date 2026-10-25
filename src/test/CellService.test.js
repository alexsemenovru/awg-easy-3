'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const test = require('node:test');
const { startCellService, syncCellOnce } = require('../lib/CellService');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { identity } = require('../lib/CellRegistration');
const { routingViewFromTopology } = require('../lib/CellRoutingView');
const { signRoutingRevision } = require('../lib/CellRoutingRevision');

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
      assert.equal(supplied.retainUserGuard, true);
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
  let staged, stageCount = 0;
  await syncCellOnce({ config: { ...config(), stateDirectory: root },
    bootstrapHost: bootstrapHost(),
    newStore: () => ({ read: async () => ({ server }) }),
    newDataIdentity: () => ({ ensure: async () => ({ privateKey: key(5), publicKey: key(6) }) }),
    newDataDeployment: options => ({ ...options, store: { read: async () => null } }),
    stageData: async ({ expected }) => { staged = expected; stageCount++;
      return { guarded: true }; },
    newGeoUpdater: () => ({ current: { database: {} }, load: async () => {} }),
    openRegistered: async supplied => ({
      protectUserTraffic: async () => {},
      recoverBoot: async () => ({ configured: true }),
      syncSettings: async () => { await supplied.receiveDataOffer(offer);
        await supplied.receiveDataOffer(offer);
        return { status: 'no-settings' }; },
    }),
  });
  assert.equal(staged.plan.spec.owner.interfaceName, 'awgdata0');
  assert.equal(staged.guardTable, 'awg_easy_3_data_guard_cell');
  assert.equal(stageCount, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'received-data-offer.json'),
    'utf8')).descriptor.controllerAddress4, '10.252.0.1');
});

test('Cell applies a received signed route only after data offer and assignments', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-service-routing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = n => Buffer.alloc(32, n).toString('base64');
  const controller = identity(), cell = identity(), cellId = 'a'.repeat(32);
  const assignment = { id: 'phone', publicKey: key(9), address4: '10.88.0.2',
    networkGroup: 'home', ipv4Enabled: true, ipv6Enabled: false,
    geoPolicy: { mode: 'off', countries: [] } };
  const offer = { version: 1, presharedKey: key(3), descriptor: {
    version: 1, slot: 0, endpointHost: '198.51.100.4', endpointPort: 53000,
    controllerAddress4: '10.252.0.1', cellAddress4: '10.252.0.2',
    controllerPublicKey: key(2), controllerClientSubnet4: '10.8.0.0/24',
    cellClientSubnet4: '10.88.0.0/24', profile: generateOfficialProfile() } };
  const view = routingViewFromTopology({ version: 1,
    nodes: [{ id: 'main', role: 'controller', ipv4: true, ipv6: false },
      { id: cellId, role: 'cell', ipv4: true, ipv6: false }],
    links: [{ a: 'main', b: cellId, ipv4: true, ipv6: false }],
    clients: [{ entry: cellId, exit: 'main', assignment }] }, cellId,
  { panel: { address4: '10.8.0.1', port: 51821 } });
  const envelope = signRoutingRevision({ cellKey: cell.publicKey, revision: 1,
    view }, controller.privateKey);
  let saved = null, applied = 0, installGeo;
  const verifiedGeo = [];
  await syncCellOnce({ config: { ...config(), stateDirectory: root },
    bootstrapHost: { connectionStore: { read: async () => ({ version: 2,
      status: 'registered', invitationId: cellId, controllerKey: controller.publicKey,
      cellKey: cell.publicKey, permanent: { privateKey: key(7) } }) },
    identityStore: {}, bootstrap: {} },
    newStore: () => ({ read: async () => ({ server: { privateKey: key(4),
      ipv4Subnet: '10.88.0.0/24', interfaceName: 'awguser0',
      wanInterface: 'eth0', listenPort: 51830 } }) }),
    newDataIdentity: () => ({ ensure: async () => ({ privateKey: key(5),
      publicKey: key(6) }) }),
    newDataDeployment: options => ({ ...options, store: { read: async () => saved },
      buildPath: () => ({ interfaceName: 'awgdata0', verifyOwned: async () => true,
        verifyOperational: async () => true }) }),
    stageData: async ({ expected }) => { saved = expected.plan; return { guarded: true }; },
    newRoutingCoordinator: options => ({ ...options,
      verifyOperational: async () => true }),
    newDataActivation: ({ routing, verifyDataLink }) => ({ activate: async spec => {
      assert.ok(spec.commands.some(command => command.args.includes('10.8.0.1/32')));
      assert.equal(await routing.verifyInterfaces(['awguser0', 'awgdata0']), true);
      assert.equal(await verifyDataLink(), true);
      applied++;
    } }),
    probeData: async () => true,
    newGeoUpdater: options => { installGeo = options.install; return {
      current: { database: {} }, load: async () => {} }; },
    openRegistered: async supplied => ({
      appliedAssignments: async () => ({ schema: 1, clients: [assignment] }),
      verifyUserRuntime: async () => {
        verifiedGeo.push(await supplied.geoDatabase());
        return true;
      },
      protectUserTraffic: async () => {},
      releaseUserGuard: async verify => assert.equal(await verify(), true),
      installGeoSnapshot: async (_snapshot, commit) => commit(),
      recoverBoot: async () => ({ configured: true }),
      syncSettings: async () => {
        await supplied.receiveDataOffer(offer);
        await supplied.receiveRoutingRevision(envelope, offer);
        await supplied.receiveRoutingRevision(envelope, offer);
        return { status: 'applied' };
      },
    }),
  });
  assert.equal(applied, 1);
  await installGeo({ database: { RU: { ipv4: [], ipv6: [] } } }, async () => {});
  assert.equal(applied, 2);
  await assert.rejects(installGeo({ database: { RU: { ipv4: [], ipv6: [] } } },
    async () => { throw new Error('GeoIP commit failed'); }), /GeoIP commit failed/);
  assert.equal(applied, 4);
  assert.deepEqual(verifiedGeo.map(database => Object.keys(database)),
    [[], [], ['RU'], ['RU'], ['RU'], ['RU'], [], []]);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'routing-inbox.json'), 'utf8'))
    .applied.revision, 1);
});
