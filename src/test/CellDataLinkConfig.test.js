'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { normalizeAwgConfig } = require('../lib/CellAwgSnapshot');
const { validateDataLinkDescriptor, renderDataControllerConfig,
  renderDataCellConfig } = require('../lib/CellDataLinkConfig');

const key = n => Buffer.alloc(32, n).toString('base64');
const keyManager = { derivePublicKey: async () => key(2) };
const descriptor = () => ({ version: 1, endpointHost: 'example.org', endpointPort: 52842,
  controllerAddress4: '10.250.0.1', cellAddress4: '10.250.0.2',
  controllerPublicKey: key(2), controllerClientSubnet4: '10.8.0.0/24',
  cellClientSubnet4: '10.88.0.0/24', profile: generateOfficialProfile() });

test('separate data-link configs carry client subnet only on controller and never include the other private key', async () => {
  const link = descriptor();
  const main = await renderDataControllerConfig({ descriptor: link, privateKey: key(1),
    cellPublicKey: key(4), presharedKey: key(3), keyManager });
  const cell = renderDataCellConfig({ descriptor: link, privateKey: key(5), presharedKey: key(3) });
  assert.deepEqual(main.addresses, ['10.250.0.1/32']);
  assert.deepEqual(cell.addresses, ['10.250.0.2/32']);
  assert.deepEqual(normalizeAwgConfig(main.config).peers[0].allowedips,
    ['10.250.0.2/32', '10.88.0.0/24']);
  assert.match(cell.config, /AllowedIPs = 10\.250\.0\.1\/32, 10\.8\.0\.0\/24/);
  assert.ok(!main.config.includes(key(5)));
  assert.ok(!cell.config.includes(key(1)));
  assert.ok(!cell.config.includes('0.0.0.0/0'));
  assert.ok(!cell.config.includes('10.254.'));
});

test('remote exit widens AWG peer AllowedIPs but does not install a host default route', () => {
  const cell = renderDataCellConfig({ descriptor: descriptor(), privateKey: key(5),
    presharedKey: key(3), remoteExit4: true });
  assert.match(cell.config, /AllowedIPs = 10\.250\.0\.1\/32, 0\.0\.0\.0\/0/);
  assert.ok(!cell.config.includes('PostUp'));
  assert.ok(!Object.hasOwn(cell, 'routes'));
});

test('IPv6 data link is all-or-nothing and enables IPv6 remote exit independently', async () => {
  const link = { ...descriptor(), controllerAddress6: 'fd90::1', cellAddress6: 'fd90::2',
    controllerClientSubnet6: 'fd46:490a:d63b::/64', cellClientSubnet6: 'fd88::/64' };
  const main = await renderDataControllerConfig({ descriptor: link, privateKey: key(1),
    cellPublicKey: key(4), presharedKey: key(3), keyManager });
  const cell = renderDataCellConfig({ descriptor: link, privateKey: key(5),
    presharedKey: key(3), remoteExit6: true });
  assert.deepEqual(main.addresses, ['10.250.0.1/32', 'fd90::1/128']);
  assert.deepEqual(cell.addresses, ['10.250.0.2/32', 'fd90::2/128']);
  assert.match(cell.config, /fd90::1\/128, ::\/0/);
  assert.throws(() => renderDataCellConfig({ descriptor: descriptor(), privateKey: key(5),
    presharedKey: key(3), remoteExit6: true }), /capabilities/);
});

test('descriptor rejects client/data overlap, subnet overlap, injected fields and partial IPv6', () => {
  for (const change of [
    value => { value.controllerAddress4 = '10.8.0.1'; },
    value => { value.cellAddress4 = '10.88.0.2'; },
    value => { value.cellClientSubnet4 = '10.8.0.128/25'; },
    value => { value.cellClientSubnet4 = '10.8.0.0/25'; },
    value => { value.controllerClientSubnet4 = '10.8.0.1/24'; },
    value => { value.controllerAddress6 = 'fd90::1'; },
    value => { value.extraCommand = 'accept'; },
  ]) {
    const link = descriptor(); change(link);
    assert.throws(() => validateDataLinkDescriptor(link));
  }
});

test('controller cannot install a data link under a different private identity', async () => {
  await assert.rejects(renderDataControllerConfig({ descriptor: descriptor(), privateKey: key(1),
    cellPublicKey: key(4), presharedKey: key(3),
    keyManager: { derivePublicKey: async () => key(9) } }), /identity mismatch/);
});
