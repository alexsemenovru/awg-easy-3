'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { identity, signRegistration, signReceipt } = require('../lib/CellRegistration');
const { createInvitation, decodeInvitation } = require('../lib/CellInvitation');
const { createRegistrationServer, registerOverTls } = require('../lib/CellRegistrationTransport');

test('real TLS registration verifies pinned identity before sending any secret', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-tls-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = identity();
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  await fs.writeFile(keyFile, controller.privateKey, { mode: 0o600 });
  const openssl = process.env.AWG_TEST_OPENSSL || (process.platform === 'win32'
    ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  execFileSync(openssl, ['req', '-new', '-x509', '-key', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=awg-control-test'], { stdio: 'pipe' });
  let calls = 0;
  const server = createRegistrationServer({ key: controller.privateKey,
    cert: await fs.readFile(certFile), handler: { handle: async bytes => {
      calls += 1;
      return { ok: true, receipt: signReceipt(JSON.parse(bytes), controller.privateKey) };
    } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const invitation = decodeInvitation(createInvitation({ host: '127.0.0.1', port,
    controllerKey: controller.publicKey }).code);
  const request = signRegistration(invitation, identity().privateKey);
  const options = { host: '127.0.0.1', port, controllerKey: controller.publicKey, request };
  assert.equal((await registerOverTls(options)).status, 'registered');
  assert.equal(calls, 1);
  await assert.rejects(registerOverTls({ ...options, controllerKey: identity().publicKey }), /identity verification/);
  assert.equal(calls, 1);
  const oversized = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false,
    ALPNProtocols: ['awg-easy-3-registration/1'] });
  await new Promise((resolve, reject) => {
    oversized.on('error', reject);
    oversized.on('secureConnect', () => oversized.write(Buffer.alloc(2050, 65)));
    oversized.on('close', resolve);
  });
  assert.equal(calls, 1);
});

test('client has an absolute deadline even when peer never starts TLS', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('data', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await assert.rejects(registerOverTls({ host: '127.0.0.1', port: server.address().port,
    controllerKey: identity().publicKey, request: {}, timeoutMs: 50 }), /timed out/);
});
