'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellDataKeyStore } = require('../lib/CellDataKeyStore');
const { CellDataIdentityStore } = require('../lib/CellDataIdentityStore');

const key = n => Buffer.alloc(32, n).toString('base64');
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-data-key-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Main pins the first authenticated Cell data key and refuses replacement', async t => {
  const root = await directory(t);
  const store = new CellDataKeyStore(path.join(root, 'announcements', 'cell.json'));
  assert.equal(await store.read(), null);
  assert.equal(await store.reserve({ version: 1, publicKey: key(1) }), true);
  assert.equal(await store.reserve({ version: 1, publicKey: key(1) }), false);
  assert.deepEqual(await store.read(), { version: 1, publicKey: key(1) });
  await assert.rejects(store.reserve({ version: 1, publicKey: key(2) }), /re-enrollment/);
  assert.deepEqual(await store.read(), { version: 1, publicKey: key(1) });
  await assert.rejects(store.reserve({ version: 1, publicKey: key(1), privateKey: key(3) }),
    /announcement/);
});

test('Cell keeps its data-link private key locally and verifies it on every startup', async t => {
  const root = await directory(t);
  let generated = 0;
  const manager = { generateKeyPair: async () => { generated++;
    return { privateKey: key(3), publicKey: key(4) }; },
  derivePublicKey: async privateKey => privateKey === key(3) ? key(4) : key(9) };
  const store = new CellDataIdentityStore(path.join(root, 'cell', 'identity.json'), manager);
  assert.deepEqual(await store.ensure(), { version: 1, privateKey: key(3), publicKey: key(4) });
  assert.deepEqual(await store.ensure(), { version: 1, privateKey: key(3), publicKey: key(4) });
  assert.equal(generated, 1);
  const file = store.filePath;
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.publicKey = key(5);
  await fs.writeFile(file, JSON.stringify(saved));
  await assert.rejects(store.ensure(), /no longer matches/);
});
