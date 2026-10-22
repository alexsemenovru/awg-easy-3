'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MainCellEntrySnapshot } = require('../lib/MainCellEntrySnapshot');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const id = 'a'.repeat(32);
const descriptor = () => ({ version: 1, endpointHost: 'cell.example.test', endpointPort: 51830,
  serverPublicKey: Buffer.alloc(32, 4).toString('base64'),
  address4: '10.64.0.1', ipv4Subnet: '10.64.0.0/24', profile: generateOfficialProfile() });

test('Main shares only validated public Cell entries in a durable private snapshot', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-main-entries-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'entries.json');
  const snapshot = new MainCellEntrySnapshot(file);
  const publicEntry = descriptor();
  assert.deepEqual(await snapshot.read(), {});
  await snapshot.write([{ id, descriptor: publicEntry, confirmed: { friend: 'c'.repeat(64) } },
    { id: 'b'.repeat(32), descriptor: null }]);
  assert.deepEqual(await snapshot.read(), { [id]: publicEntry });
  assert.deepEqual((await snapshot.readDetails())[id].confirmed, { friend: 'c'.repeat(64) });
  assert.equal((await fs.readFile(file, 'utf8')).includes('privateKey'), false);
  await assert.rejects(snapshot.write([{ id, descriptor: { ...publicEntry, privateKey: 'secret' } }]));
  assert.deepEqual(await snapshot.read(), { [id]: publicEntry });
});
