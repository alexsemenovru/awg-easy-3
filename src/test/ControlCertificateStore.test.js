'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { ControlCertificateStore } = require('../lib/ControlCertificateStore');
const { CellEnrollmentStore } = require('../lib/CellEnrollmentStore');
const { CellConnectionStore } = require('../lib/CellConnectionStore');
const { prepareRegistrationEndpoint } = require('../lib/CellRegistrationEndpoint');
const { registerOverTls } = require('../lib/CellRegistrationTransport');
const { decodeInvitation } = require('../lib/CellInvitation');
const { identity: createIdentity, signRegistration } = require('../lib/CellRegistration');
const openssl = process.env.AWG_TEST_OPENSSL || (process.platform === 'win32'
  ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-cert-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identities = new ControlIdentityStore(path.join(directory, 'identity.json'));
  const identity = await identities.create('controller');
  const file = path.join(directory, 'cert.pem');
  return { directory, identities, identity, file };
}

test('self-signed certificate uses persistent identity and is reused concurrently', async t => {
  const { directory, identities, identity, file } = await fixture(t);
  let executions = 0;
  const execute = async (...args) => { executions++; return run(...args); };
  const store = new ControlCertificateStore(file, identities, { openssl, execute });
  const [a, b] = await Promise.all([store.ensure(), store.ensure()]);
  assert.equal(a, b);
  assert.equal(executions, 1);
  const cert = new crypto.X509Certificate(a);
  assert.equal(cert.publicKey.export({ format: 'jwk' }).x, identity.publicKey);
  assert.ok(cert.verify(cert.publicKey));
  assert.equal(await new ControlCertificateStore(file, identities, { openssl }).ensure(), a);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['cert.pem', 'identity.json']);
});

test('renewal keeps identity and generation failure preserves existing certificate', async t => {
  const { identities, identity, file, directory } = await fixture(t);
  const short = new ControlCertificateStore(file, identities, { openssl, execute: async (bin, args, opts) => {
    const changed = [...args];
    changed[changed.indexOf('-days') + 1] = '1';
    await run(bin, changed, opts);
    // Populate a short-lived existing certificate without bypassing production validation.
    await fs.copyFile(changed[changed.indexOf('-out') + 1], file);
  } });
  await assert.rejects(short.ensure(), /validity/);
  const old = await fs.readFile(file, 'utf8');
  const failing = new ControlCertificateStore(file, identities, { execute: async () => { throw new Error('secret detail'); } });
  await assert.rejects(failing.ensure(), /OpenSSL availability/);
  assert.equal(await fs.readFile(file, 'utf8'), old);
  const renewed = await new ControlCertificateStore(file, identities, { openssl }).ensure();
  assert.notEqual(renewed, old);
  assert.equal(new crypto.X509Certificate(renewed).publicKey.export({ format: 'jwk' }).x, identity.publicKey);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['cert.pem', 'identity.json']);
});

test('corrupt or mismatched certificate fails without replacing identity or certificate', async t => {
  const { identities, file, directory } = await fixture(t);
  const other = await fixture(t);
  const foreign = await new ControlCertificateStore(other.file, other.identities, { openssl }).ensure();
  const before = await fs.readFile(path.join(directory, 'identity.json'), 'utf8');
  for (const pem of ['not a certificate', foreign]) {
    await fs.writeFile(file, pem);
    await assert.rejects(new ControlCertificateStore(file, identities, { openssl }).ensure(), /Invalid control certificate/);
    assert.equal(await fs.readFile(file, 'utf8'), pem);
    assert.equal(await fs.readFile(path.join(directory, 'identity.json'), 'utf8'), before);
  }
});

test('prepared endpoint completes real registration with persistent stores and generated certificate', async t => {
  const { identities, identity, file, directory } = await fixture(t);
  const enrollmentStore = new CellEnrollmentStore(path.join(directory, 'enrollment.json'));
  const server = await prepareRegistrationEndpoint({ identityStore: identities, enrollmentStore,
    certificateStore: new ControlCertificateStore(file, identities, { openssl }) });
  assert.equal(server.listening, false);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const invitation = decodeInvitation(await enrollmentStore.create({ host: '127.0.0.1', port,
    controllerKey: identity.publicKey }));
  const request = signRegistration(invitation, createIdentity().privateKey);
  const result = await registerOverTls({ host: '127.0.0.1', port,
    controllerKey: identity.publicKey, request });
  assert.equal(result.status, 'registered');
  assert.equal((await enrollmentStore.read()).invitations[0].cellKey, result.cellKey);
  const cellIdentities = new ControlIdentityStore(path.join(directory, 'cell-identity.json'));
  await cellIdentities.create('cell');
  const connection = new CellConnectionStore(path.join(directory, 'connection.json'), cellIdentities);
  await connection.begin(await enrollmentStore.create({ host: '127.0.0.1', port,
    controllerKey: identity.publicKey }));
  assert.deepEqual(await connection.resume(), { status: 'registered' });
  assert.equal((await enrollmentStore.read()).invitations.length, 2);
  assert.deepEqual(await new CellConnectionStore(connection.filePath, cellIdentities).resume(), { status: 'registered' });
});
