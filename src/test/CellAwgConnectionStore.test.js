'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { CellAwgConnectionStore } = require('../lib/CellAwgConnectionStore');
const { signAwgReceipt, verifyAwgReceipt } = require('../lib/CellAwgRegistration');
const { generateOfficialProfile } = require('../lib/Awg3Config');

const key = () => crypto.randomBytes(32).toString('base64');
function permanent() {
  const pair = crypto.generateKeyPairSync('x25519');
  return { privateKey: Buffer.from(pair.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'),
    publicKey: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
    presharedKey: key() };
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cell-connection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identities = new ControlIdentityStore(path.join(directory, 'cell-identity.json'));
  await identities.create('cell');
  const controller = crypto.generateKeyPairSync('ed25519');
  const controllerPrivate = controller.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const controllerKey = controller.publicKey.export({ format: 'jwk' }).x;
  const issued = await createAwgBootstrapInvitation({ controllerKey,
    endpointHost: 'example.test', endpointPort: 51824, registrationPort: 51822,
    controllerAddress: '10.90.0.1', cellAddress: '10.90.0.2', serverPublicKey: key(),
    profile: generateOfficialProfile(), keyManager: { generatePeerKeys: async () => ({
      privateKey: key(), publicKey: key(), presharedKey: key(),
    }) }, now: 1000, lifetimeMs: 60000 });
  const permanentKeys = permanent();
  let now = 1002, attempts = 0;
  const file = path.join(directory, 'connection.json');
  const options = { now: () => now, keyManager: { generatePeerKeys: async () => permanentKeys },
    connect: async ({ controllerKey: keyFromRequest, request }) => {
      attempts++;
      assert.equal(keyFromRequest, controllerKey);
      const receipt = signAwgReceipt(request, controllerPrivate, now);
      return verifyAwgReceipt(receipt, request, controllerKey, now);
    } };
  const store = new CellAwgConnectionStore(file, identities, options);
  return { store, file, identities, issued, permanentKeys, options,
    setNow: value => { now = value; }, attempts: () => attempts };
}

test('cell creates its own permanent key and scrubs temporary invitation after confirmation', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.begin(f.issued.code), { status: 'pending' });
  const pending = await f.store.read();
  assert.equal(pending.permanent.publicKey, f.permanentKeys.publicKey);
  assert.equal(pending.request.awgPublicKey, f.permanentKeys.publicKey);
  const reopened = new CellAwgConnectionStore(f.file, f.identities, f.options);
  assert.deepEqual(await reopened.resume(), { status: 'registered' });
  assert.equal(f.attempts(), 1);
  const registered = await reopened.read();
  assert.equal(registered.status, 'registered');
  assert.equal(registered.permanent.privateKey, f.permanentKeys.privateKey);
  assert.equal(Object.hasOwn(registered, 'invitation'), false);
  assert.equal(Object.hasOwn(registered, 'request'), false);
  const raw = await fs.readFile(f.file, 'utf8');
  assert.equal(raw.includes(pending.invitation.secret), false);
  assert.equal(raw.includes(pending.invitation.temporaryPrivateKey), false);
  assert.deepEqual(await reopened.resume(), { status: 'registered' });
  assert.equal(f.attempts(), 1);
});

test('failed confirmation leaves an unchanged pending request for bounded retry', async t => {
  const f = await fixture(t);
  await f.store.begin(f.issued.code);
  const before = await f.store.read();
  f.store.connect = async () => { throw new Error('temporary link down'); };
  await assert.rejects(f.store.resume(), /temporary link down/);
  assert.deepEqual(await f.store.read(), before);
  f.setNow(61000);
  await assert.rejects(f.store.resume(), /expired/);
  assert.deepEqual(await f.store.read(), before);
});

test('corrupt permanent key pair and repeated begin are refused without replacement', async t => {
  const f = await fixture(t);
  await f.store.begin(f.issued.code);
  await assert.rejects(f.store.begin(f.issued.code), /already exists/);
  const pending = await f.store.read();
  pending.permanent.publicKey = key();
  await fs.writeFile(f.file, JSON.stringify(pending));
  await assert.rejects(f.store.read(), /Invalid AWG cell connection state/);
});
