'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { startCellService } = require('../lib/CellService');

const config = () => ({ stateDirectory: path.resolve('cell-state'),
  runtimeDirectory: path.resolve('cell-runtime'), interfaceName: 'awgboot0',
  resources: { interfaceNames: ['awgboot0', 'awgctl0', 'awguser0'], udpPorts: [51830] } });

test('Cell service restores signed state before polling and closes poller only', async () => {
  const order = [];
  let args;
  let complete;
  const running = new Promise(resolve => { complete = resolve; });
  const service = await startCellService({ config: config(),
    bootstrapHost: { connectionStore: {}, identityStore: {}, bootstrap: {} },
    newStore: (filename, reserved) => {
      assert.equal(filename, path.join(config().stateDirectory, 'user-config.json'));
      assert.deepEqual(reserved, { interfaceName: 'awguser0', listenPort: 51830 });
      return { read: async () => ({ server: { interfaceName: 'awguser0' } }) };
    },
    newGeoUpdater: () => ({ current: { database: { RU: { ipv4: [], ipv6: [] } } },
      load: async () => { order.push('geo'); } }),
    openRegistered: async supplied => {
      args = supplied;
      order.push('registered');
      return { recoverBoot: async () => { order.push('restore'); return { configured: true }; },
        createPoller: () => ({ start: () => { order.push('poll'); return running; },
          stop: async () => { order.push('stop'); complete(); } }) };
    } });
  assert.equal(service.status, 'serving');
  assert.deepEqual(await args.geoDatabase(), { RU: { ipv4: [], ipv6: [] } });
  assert.deepEqual(order, ['geo', 'registered', 'restore', 'poll']);
  await service.close();
  assert.deepEqual(order, ['geo', 'registered', 'restore', 'poll', 'stop']);
});

test('Cell service refuses missing user config and incomplete permanent path', async () => {
  let registered = false;
  await assert.rejects(startCellService({ config: config(), bootstrapHost: {},
    newStore: () => ({ read: async () => null }),
    openRegistered: async () => { registered = true; } }), /not installed/);
  assert.equal(registered, false);
  await assert.rejects(startCellService({ config: config(), bootstrapHost: {},
    newStore: () => ({ read: async () => ({ server: {} }) }),
    newGeoUpdater: () => ({ load: async () => null }),
    openRegistered: async () => ({ recoverBoot: async () => ({ configured: false }) }),
  }), /not configured/);
});
