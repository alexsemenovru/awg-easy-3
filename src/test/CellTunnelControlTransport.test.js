'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { identity } = require('../lib/CellRegistration');
const { signControl, signControlReply } = require('../lib/CellControlProtocol');
const { listenControlOnTunnel, exchangeOverTunnel, privateAddress } = require('../lib/CellTunnelControlTransport');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { CellSettingsPublisher } = require('../lib/CellSettingsPublisher');
const { CellSettingsReceiver } = require('../lib/CellSettingsReceiver');
const { CellAwgBootstrapStore } = require('../lib/CellAwgBootstrapStore');
const { CellAwgLifecycle } = require('../lib/CellAwgLifecycle');
const { createAwgOwnership } = require('../lib/CellAwgOwnership');
const { listenTunnelControlEndpoint, syncCellSettings,
  fetchCellRoutingRevision } = require('../lib/CellControlService');
const { routingViewFromTopology } = require('../lib/CellRoutingView');
const { signRoutingRevision } = require('../lib/CellRoutingRevision');

const ownedLoopback = () => ({
  load: async () => ({ phase: 'ready', spec: { owner: { interfaceName: 'testawg' },
    addresses: ['127.0.0.1/32'] } }),
  verify: async () => ({ up: true }),
});

test('tunnel control transport refuses public addresses and never auto-listens', async () => {
  for (const address of ['0.0.0.0', '216.57.108.77', '::', '2001:db8::1', 'localhost']) {
    assert.equal(privateAddress(address), false);
    await assert.rejects(listenControlOnTunnel({ address, port: 0, handler: { handle() {} } }),
      /private/);
  }
  for (const address of ['127.0.0.1', '10.88.0.1', '172.16.0.1', '192.168.1.1', '::1', 'fd35:e03:5563::1']) {
    assert.equal(privateAddress(address), true);
  }
  assert.equal(privateAddress('172.32.0.1'), false);
});

test('tunnel exchange verifies a signed control reply without TLS', async t => {
  const controller = identity();
  const cell = identity();
  const request = signControl({ controllerKey: controller.publicKey, action: 'poll' }, cell.privateKey);
  const server = await listenControlOnTunnel({ address: '127.0.0.1', port: 0,
    handler: { handle: async bytes => {
      assert.equal(JSON.parse(bytes).requestId, request.requestId);
      return signControlReply({ ok: true, requestId: request.requestId,
        settings: { revision: 1 } }, controller.privateKey);
    } } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const reply = await exchangeOverTunnel({ address: '127.0.0.1', port: server.address().port,
    request, controllerKey: controller.publicKey });
  assert.equal(reply.settings.revision, 1);
  await assert.rejects(exchangeOverTunnel({ address: '127.0.0.1', port: server.address().port,
    request, controllerKey: identity().publicKey }), /Control reply rejected/);
  assert.throws(() => exchangeOverTunnel({ address: '216.57.108.77', port: server.address().port,
    request, controllerKey: controller.publicKey }), /private/);
});

test('registered Cell fetches only its signed routing view over owned AWG control', async t => {
  const controller = identity(), cell = identity(), invitationId = 'a'.repeat(32);
  const view = routingViewFromTopology({ version: 1,
    nodes: [{ id: 'main', role: 'controller', ipv4: true, ipv6: false },
      { id: invitationId, role: 'cell', ipv4: true, ipv6: false }],
    links: [{ a: 'main', b: invitationId, ipv4: true, ipv6: false }], clients: [] },
  invitationId);
  const routing = signRoutingRevision({ cellKey: cell.publicKey, revision: 1,
    view }, controller.privateKey);
  const server = await listenTunnelControlEndpoint({ address: '127.0.0.1', port: 0,
    identityStore: { load: async () => controller }, lifecycle: ownedLoopback(),
    bootstrapStore: { read: async () => ({ version: 2, invitations: [{
      status: 'consumed', phase: 'closed', cellKey: cell.publicKey,
      awgPublicKey: 'key', awgPresharedKey: 'psk' }] }) },
    routingForCell: () => ({ load: async () => routing }) });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const connection = { version: 2, status: 'registered', invitationId,
    controllerKey: controller.publicKey, cellKey: cell.publicKey };
  const options = { connectionStore: { read: async () => connection },
    identityStore: { load: async () => cell }, host: '127.0.0.1',
    port: server.address().port };
  assert.deepEqual(await fetchCellRoutingRevision(options), routing);
  await assert.rejects(fetchCellRoutingRevision({ ...options,
    connectionStore: { read: async () => ({ ...connection,
      invitationId: 'b'.repeat(32) }) } }), /routing view/);
});

test('tunnel exchange rejects an altered or mismatched reply', async t => {
  const controller = identity();
  const cell = identity();
  const request = signControl({ controllerKey: controller.publicKey, action: 'poll' }, cell.privateKey);
  let mutation = reply => ({ ...reply, settings: { revision: 2 } });
  const server = await listenControlOnTunnel({ address: '127.0.0.1', port: 0,
    handler: { handle: async () => mutation(signControlReply({ ok: true,
      requestId: request.requestId, settings: { revision: 1 } }, controller.privateKey)) } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { address: '127.0.0.1', port: server.address().port,
    request, controllerKey: controller.publicKey };
  await assert.rejects(exchangeOverTunnel(options), /Control reply rejected/);
  mutation = reply => ({ ...reply, requestId: 'b'.repeat(32) });
  await assert.rejects(exchangeOverTunnel(options), /Control reply rejected/);
});

test('registered cell polls and acknowledges settings over the tunnel transport', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-tunnel-control-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identities = new ControlIdentityStore(path.join(directory, 'controller.json'));
  const controller = await identities.create('controller');
  const cellIdentities = new ControlIdentityStore(path.join(directory, 'cell.json'));
  const cell = await cellIdentities.create('cell');
  const bootstrapStore = new CellAwgBootstrapStore(path.join(directory, 'bootstrap.json'));
  const key = () => crypto.randomBytes(32).toString('base64');
  const record = { version: 2, id: crypto.randomBytes(16).toString('hex'),
    status: 'consumed', phase: 'ready', createdAt: 1000, expiresAt: 61000,
    secretHash: crypto.randomBytes(32).toString('hex'), temporaryPublicKey: key(),
    temporaryPresharedKey: key(), cellAddress: '10.90.0.2',
    requestId: crypto.randomBytes(16).toString('hex'), cellKey: cell.publicKey,
    changedAt: 1002, awgPublicKey: key(), awgPresharedKey: key() };
  await bootstrapStore.write({ version: 2, invitations: [record] });
  const publisher = new CellSettingsPublisher(path.join(directory, 'desired.json'), identities, cell.publicKey);
  const server = await listenTunnelControlEndpoint({ address: '127.0.0.1', port: 0,
    identityStore: identities, bootstrapStore, lifecycle: ownedLoopback(),
    publisherForCell: key => { assert.equal(key, cell.publicKey); return publisher; } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  let applies = 0;
  const receiver = new CellSettingsReceiver(path.join(directory, 'received.json'), {
    controllerKey: controller.publicKey, cellKey: cell.publicKey,
    apply: async () => { applies++; },
  });
  const options = { connectionStore: { read: async () => ({ version: 2, status: 'registered',
    controllerKey: controller.publicKey, cellKey: cell.publicKey }) },
  identityStore: cellIdentities, receiver, host: '127.0.0.1', port: server.address().port,
  transport: 'tunnel' };
  // Consumed invitation alone is not authority to manage the cell: the
  // permanent AWG path must have been verified and the temporary peer retired.
  await assert.rejects(syncCellSettings(options), /Control reply rejected/);
  await assert.rejects(syncCellSettings({ ...options, transport: 'tls' }), /requires the tunnel/);
  await assert.rejects(syncCellSettings({ ...options, transport: undefined }), /requires the tunnel/);
  await assert.rejects(syncCellSettings({ ...options,
    connectionStore: { read: async () => ({ version: 3, status: 'registered' }) } }), /Unsupported cell connection version/);
  await bootstrapStore.write({ version: 2, invitations: [{ ...record,
    phase: 'closed', temporaryPresharedKey: null }] });
  assert.equal((await syncCellSettings(options)).status, 'no-settings');
  await publisher.publish({ schema: 1, clients: [] });
  assert.deepEqual(await syncCellSettings(options), { status: 'applied', revision: 1 });
  assert.equal((await publisher.load()).ack.revision, 1);
  await syncCellSettings(options);
  assert.equal(applies, 1);
});

test('tunnel control rejects legacy enrollment and incomplete v2 identity', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-tunnel-denied-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identities = new ControlIdentityStore(path.join(directory, 'controller.json'));
  const controller = await identities.create('controller');
  const cell = identity();
  await assert.rejects(listenTunnelControlEndpoint({ address: '127.0.0.1', port: 0,
    identityStore: identities, enrollmentStore: { read: async () => ({ invitations: [] }) },
    publisherForCell: () => {} }), /AWG bootstrap store required/);
  const bootstrapStore = new CellAwgBootstrapStore(path.join(directory, 'bootstrap.json'));
  const server = await listenTunnelControlEndpoint({ address: '127.0.0.1', port: 0,
    identityStore: identities, bootstrapStore, lifecycle: ownedLoopback(),
    publisherForCell: () => { throw new Error('Unauthorised publisher access'); } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = signControl({ controllerKey: controller.publicKey, action: 'poll' }, cell.privateKey);
  await assert.rejects(exchangeOverTunnel({ address: '127.0.0.1', port: server.address().port,
    request, controllerKey: controller.publicKey }), /Control reply rejected/);
});

test('tunnel control listener requires a ready owned AWG address and a live device', async () => {
  const base = { address: '127.0.0.1', port: 0,
    bootstrapStore: { read: async () => ({ version: 2, invitations: [] }) },
    identityStore: {}, publisherForCell: () => {} };
  await assert.rejects(listenTunnelControlEndpoint(base), /lifecycle required/);
  const lifecycle = ownedLoopback();
  await assert.rejects(listenTunnelControlEndpoint({ ...base,
    lifecycle: { ...lifecycle, load: async () => ({ phase: 'creating' }) } }), /not ready/);
  await assert.rejects(listenTunnelControlEndpoint({ ...base,
    lifecycle: { ...lifecycle, load: async () => ({ phase: 'ready',
      spec: { owner: { interfaceName: 'testawg' }, addresses: ['10.88.0.1/32'] } }) } }), /not owned/);
  await assert.rejects(listenTunnelControlEndpoint({ ...base,
    lifecycle: { ...lifecycle, verify: async () => ({ up: false }) } }), /down/);
  await assert.rejects(listenTunnelControlEndpoint({ ...base,
    lifecycle: { ...lifecycle, verify: async () => { throw new Error('AWG drift'); } } }), /AWG drift/);
});

test('tunnel listener checks the real lifecycle journal and AWG readback before binding', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-tunnel-owned-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = `[Interface]\nPrivateKey = ${Buffer.alloc(32, 7).toString('base64')}\nListenPort = 54322\nJc = 3\n`;
  const spec = { version: 1, owner: createAwgOwnership({ interfaceName: 'cell0', config }),
    addresses: ['127.0.0.1/32'] };
  let alias = spec.owner.ownerTag;
  const lifecycle = new CellAwgLifecycle({ journalPath: path.join(directory, 'owned.json'),
    activateGuard: async () => {}, runner: async (file, args) => {
      if (file === 'ip' && args[0] === '-d') return { stdout: JSON.stringify([{
        ifname: 'cell0', ifalias: alias, mtu: spec.owner.mtu, flags: ['UP'],
        linkinfo: { info_kind: 'tun', info_data: { type: 'tun' } },
      }]) };
      if (file === 'ip' && args[0] === '-j') return { stdout: JSON.stringify([{
        ifname: 'cell0', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 32 }],
      }]) };
      if (file === 'awg' && args[0] === 'showconf') return { stdout: config };
      if (file === 'sysctl' && args[0] === '-n') return { stdout: '2' };
      throw new Error('Unexpected AWG mutation');
    } });
  await lifecycle.save({ version: 1, phase: 'ready', spec, blankHash: null });
  const options = { address: '127.0.0.1', port: 0, lifecycle,
    bootstrapStore: { read: async () => ({ version: 2, invitations: [] }) },
    identityStore: {}, publisherForCell: () => {} };
  const server = await listenTunnelControlEndpoint(options);
  await new Promise(resolve => server.close(resolve));
  alias = 'foreign-owner';
  await assert.rejects(listenTunnelControlEndpoint(options), /Foreign or unproven AWG interface/);
});
