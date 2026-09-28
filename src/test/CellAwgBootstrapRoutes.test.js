'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapServerRoutes, bootstrapCellRoutes } = require('../lib/CellAwgBootstrapRoutes');
const { manifest } = require('../lib/CellRouteOwnership');

test('bootstrap routes are exact private hosts on only the dedicated interface', () => {
  const server = bootstrapServerRoutes({ interfaceName: 'awg-enroll',
    controllerAddress: '10.90.0.1', peers: [
      { phase: 'ready', cellAddress: '10.90.0.3' },
      { phase: 'preparing', cellAddress: '10.90.0.2' },
      { phase: 'closing', cellAddress: '10.90.0.4' },
    ] });
  assert.deepEqual(server.map(item => item.args), [
    ['-4', 'route', 'add', '10.90.0.2/32', 'table', 'main', 'proto', '186', 'dev', 'awg-enroll'],
    ['-4', 'route', 'add', '10.90.0.3/32', 'table', 'main', 'proto', '186', 'dev', 'awg-enroll'],
  ]);
  assert.equal(manifest(server).length, 2);
  assert.deepEqual(bootstrapCellRoutes({ interfaceName: 'awg-enroll',
    cellAddress: '10.90.0.2', controllerAddress: '10.90.0.1' })[0].args,
  ['-4', 'route', 'add', '10.90.0.1/32', 'table', 'main', 'proto', '186', 'dev', 'awg-enroll']);
});

test('bootstrap route compiler validates IPv6 and rejects overlaps or public routes', () => {
  const v6 = bootstrapCellRoutes({ interfaceName: 'awg-enroll',
    cellAddress: 'fd35:e03:5563::2', controllerAddress: 'fd35:e03:5563::1' });
  assert.equal(v6[0].args[0], '-6');
  assert.equal(v6[0].args[3], 'fd35:e03:5563::1/128');
  for (const peer of [{ phase: 'ready', cellAddress: '8.8.8.8' },
    { phase: 'ready', cellAddress: '10.90.0.1' }]) {
    assert.throws(() => bootstrapServerRoutes({ interfaceName: 'awg-enroll',
      controllerAddress: '10.90.0.1', peers: [peer] }));
  }
  assert.throws(() => bootstrapCellRoutes({ interfaceName: 'awg-enroll',
    cellAddress: '10.90.0.2', controllerAddress: 'fd35:e03:5563::1' }));
});
