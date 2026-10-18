'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cellUserSubnet, ensureCellUserBootstrap } = require('../lib/CellUserBootstrap');
const { generateOfficialProfile } = require('../lib/Awg3Config');

test('automatic Cell user subnets are distinct across all allocated permanent addresses', () => {
  const seen = new Set();
  for (let group = 0; group < 4; group++) {
    for (let host = 2; host <= 254; host++) {
      const subnet = cellUserSubnet({ controllerAddress: '10.91.8.1',
        cellAddress: `10.91.${8 + group}.${host}` });
      assert.equal(seen.has(subnet.ipv4Subnet), false);
      seen.add(subnet.ipv4Subnet);
    }
  }
  assert.equal(seen.size, 1012);
  assert.throws(() => cellUserSubnet({ controllerAddress: '10.91.8.1',
    cellAddress: '10.91.12.2' }), /allocated permanent/);
});

test('Cell user bootstrap persists a private empty tunnel once and preserves it on restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-user-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { stateDirectory: directory,
    resources: { interfaceNames: ['awgjoin0', 'awgctl0', 'awguser0'], udpPorts: [51830] } };
  const connection = { status: 'registered', controllerPath: {
    controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2' } };
  const key = Buffer.alloc(32, 7).toString('base64');
  const options = { config, connection, wanInterface: 'eth0',
    keyManager: { generatePrivateKey: async () => key }, makeProfile: generateOfficialProfile };
  await assert.rejects(ensureCellUserBootstrap({ ...options,
    wanInterface: 'awgctl0' }), /WAN interface required/);
  assert.deepEqual(await ensureCellUserBootstrap(options), { created: true });
  const file = path.join(directory, 'user-config.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.server.address4, '10.64.0.1');
  assert.equal(saved.server.privateKey, key);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o077, 0);
  assert.deepEqual(await ensureCellUserBootstrap({ ...options,
    keyManager: { generatePrivateKey: async () => { throw new Error('must not rotate'); } } }),
  { created: false });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved);
});
