'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { validateCellUserDescriptor } = require('../lib/CellUserDescriptor');
const { CellUserDescriptorStore } = require('../lib/CellUserDescriptorStore');

const descriptor = () => ({ version: 1, endpointHost: '198.51.100.3', endpointPort: 51830,
  serverPublicKey: crypto.randomBytes(32).toString('base64'), address4: '10.64.0.1',
  ipv4Subnet: '10.64.0.0/24', profile: generateOfficialProfile() });

test('public Cell descriptor rejects secrets, malformed endpoints and mismatched subnets', () => {
  const value = descriptor();
  assert.deepEqual(validateCellUserDescriptor(value), value);
  for (const bad of [
    { ...value, privateKey: crypto.randomBytes(32).toString('base64') },
    { ...value, endpointHost: '127.0.0.1' },
    { ...value, endpointPort: 0 },
    { ...value, address4: '10.65.0.1' },
    { ...value, serverPublicKey: 'not-a-key' },
    { ...value, address6: 'fd00::1' },
  ]) assert.throws(() => validateCellUserDescriptor(bad));
});

test('Main stores only a validated public descriptor and replaces it atomically', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-descriptor-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'private', 'descriptor.json');
  const store = new CellUserDescriptorStore(file);
  const first = descriptor();
  assert.equal(await store.read(), null);
  assert.equal(await store.update(first), true);
  assert.equal(await store.update(first), false);
  assert.deepEqual(await store.read(), first);
  await assert.rejects(store.update({ ...first, privateKey: 'leak' }));
  assert.deepEqual(await store.read(), first);
  const next = { ...first, endpointHost: '203.0.113.12' };
  assert.equal(await store.update(next), true);
  assert.deepEqual(await store.read(), next);
});
