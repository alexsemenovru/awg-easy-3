'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { identity } = require('../lib/CellRegistration');
const { createRecoveryMaterial, signBackupGrant, verifyBackupGrant,
  signBackupAck, signTakeover } = require('../lib/BackupRecovery');
const { CellBackupRecoveryStore } = require('../lib/CellBackupRecoveryStore');
const { MainBackupStore } = require('../lib/MainBackupStore');
const { MainBackupRecovery } = require('../lib/MainBackupRecovery');
const { CellSettingsReceiver } = require('../lib/CellSettingsReceiver');
const { CellSettingsPublisher } = require('../lib/CellSettingsPublisher');
const { signSettings } = require('../lib/CellSettings');
const { epochFor } = require('../lib/CellControlAuthority');
const { CellAwgConnectionStore } = require('../lib/CellAwgConnectionStore');
const { CellAwgBootstrapStore } = require('../lib/CellAwgBootstrapStore');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { listenAwgRegistrationOnTunnel } = require('../lib/CellTunnelRegistrationTransport');
const { signControl, signControlReply, signAuthorityReply } = require('../lib/CellControlProtocol');
const { listenControlOnTunnel, exchangeOverTunnel } = require('../lib/CellTunnelControlTransport');
const { CellControlService, syncCellSettings } = require('../lib/CellControlService');
const { StateStore } = require('../lib/StateStore');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { createConfigurationBackup } = require('../lib/ConfigurationBackup');
const { decodeConfiguration } = require('../lib/BackupSnapshot');
const awgKeys = () => {
  const pair = crypto.generateKeyPairSync('x25519');
  return { privateKey: Buffer.from(pair.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'),
    publicKey: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') };
};
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const main = identity(), cell = identity(), authority = identity();
  const trust = { controllerKey: main.publicKey, cellKey: cell.publicKey };
  const material = createRecoveryMaterial(1);
  const grant = signBackupGrant(material, Buffer.from('test encrypted archive'), main.privateKey);
  const store = new CellBackupRecoveryStore(path.join(directory, 'backup-recovery.json'), trust);
  const mainStore = new MainBackupStore(path.join(directory, 'main-backup.json'), main.publicKey);
  const proof = challenge => signTakeover({ grant, material, cellKey: cell.publicKey,
    authorityKey: authority.publicKey, endpointHost: '198.51.100.40', challenge });
  return { directory, main, cell, authority, trust, material, grant, store, mainStore, proof };
}
test('latest signed backup grant survives restart, rejects older/conflicting grants and foreign acknowledgements', async t => {
  const f = await fixture(t);
  await f.mainStore.commit(f.grant, [f.cell.publicKey]);
  await f.store.accept(f.grant);
  const restarted = new CellBackupRecoveryStore(path.join(f.directory, 'backup-recovery.json'), f.trust);
  const ack = await restarted.acknowledgement(f.cell.privateKey);
  await f.mainStore.acknowledge(f.cell.publicKey, ack);
  assert.deepEqual(await f.mainStore.status(f.cell.publicKey), { generation: 1, confirmed: true });
  const laterCell = identity();
  assert.equal(await f.mainStore.grant(laterCell.publicKey), null);
  await assert.rejects(f.mainStore.acknowledge(laterCell.publicKey, signBackupAck(f.grant, laterCell.privateKey)), /not included/);
  await assert.rejects(f.mainStore.acknowledge(identity().publicKey, ack));
  await assert.rejects(f.mainStore.commit(f.grant, [f.cell.publicKey]), /increase/);
  const second = signBackupGrant(createRecoveryMaterial(2), Buffer.from('second archive'), f.main.privateKey);
  await restarted.accept(second);
  await f.mainStore.commit(second, [f.cell.publicKey]);
  assert.deepEqual(await f.mainStore.status(f.cell.publicKey), { generation: 2, confirmed: false });
  await assert.rejects(f.mainStore.acknowledge(f.cell.publicKey, ack));
  await assert.rejects(restarted.accept(f.grant), /Older/);
  const conflict = signBackupGrant(createRecoveryMaterial(2), Buffer.from('conflict'), f.main.privateKey);
  await assert.rejects(restarted.accept(conflict), /Conflicting/);
  assert.throws(() => verifyBackupGrant({ ...second, archiveHash: '0'.repeat(64) }, f.main.publicKey));
  assert.equal((await fs.readFile(path.join(f.directory, 'backup-recovery.json'), 'utf8')).includes('PRIVATE KEY'), false);
});
test('takeover requires a fresh Cell challenge and latest archive; durable consumption fences concurrent restores', async t => {
  const f = await fixture(t);
  await f.store.accept(f.grant);
  const challenge = await f.store.challenge(1000);
  assert.deepEqual(await f.store.challenge(1001), challenge);
  const proof = f.proof(challenge.nonce);
  for (const forged of [{ ...proof, endpointHost: '198.51.100.41' },
    { ...proof, challenge: crypto.randomBytes(32).toString('base64url') },
    { ...proof, cellKey: identity().publicKey }, { ...proof, archiveHash: '1'.repeat(64) }]) {
    await assert.rejects(f.store.consume(forged, 1002));
  }
  await assert.rejects(f.store.consume(proof, challenge.expiresAt), /expired/);
  const attempts = await Promise.allSettled([f.store.consume(proof, 1003), f.store.consume(proof, 1004)]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const restarted = new CellBackupRecoveryStore(path.join(f.directory, 'backup-recovery.json'), f.trust);
  assert.equal((await restarted.read()).authority.proof.authorityKey, f.authority.publicKey);
  await assert.rejects(restarted.consume(proof, 1005), /consumed/);
  await restarted.accept(f.grant);
  await assert.rejects(restarted.challenge(1005), /unavailable/);
  const next = signBackupGrant(createRecoveryMaterial(2), Buffer.from('next archive'), f.main.privateKey);
  await restarted.accept(next);
  assert.equal((await restarted.read()).authority.proof.authorityKey, f.authority.publicKey);
  const nextChallenge = await restarted.challenge(2000);
  await assert.rejects(restarted.consume(f.proof(nextChallenge.nonce), 2001));
  const lostJournal = new CellBackupRecoveryStore(path.join(f.directory, 'lost-recovery.json'),
    { ...f.trust, authorityGeneration: 1 });
  await lostJournal.accept(f.grant);
  await assert.rejects(lostJournal.challenge(3000), /unavailable/);
});
test('fresh live authority is required over real TCP after takeover; old signing key alone cannot manage Cell', async t => {
  const f = await fixture(t);
  const request = signControl({ controllerKey: f.main.publicKey, action: 'poll' }, f.cell.privateKey);
  let wrapping = null;
  const server = await listenControlOnTunnel({ address: '127.0.0.1', port: 0,
    handler: { handle: async () => {
      const reply = signControlReply({ ok: true, requestId: request.requestId, settings: null }, f.main.privateKey);
      return wrapping ? signAuthorityReply(reply, wrapping) : reply;
    } } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { address: '127.0.0.1', port: server.address().port, request,
    controllerKey: f.main.publicKey, authorityKey: f.authority.publicKey };
  await assert.rejects(exchangeOverTunnel(options), /rejected/);
  wrapping = f.main.privateKey;
  await assert.rejects(exchangeOverTunnel(options), /rejected/);
  wrapping = f.authority.privateKey;
  assert.equal((await exchangeOverTunnel(options)).settings, null);
  await assert.rejects(exchangeOverTunnel({ ...options, request: { ...request,
    requestId: '1'.repeat(32) } }), /rejected/);
});
test('registered Cell receives and acknowledges backup generation over the existing signed AWG control RPC', async t => {
  const f = await fixture(t);
  await f.mainStore.commit(f.grant, [f.cell.publicKey]);
  const service = new CellControlService({ identityStore: { load: async () => f.main },
    bootstrapStore: { read: async () => ({ version: 2, invitations: [{ status: 'consumed', phase: 'closed',
      cellKey: f.cell.publicKey, awgPublicKey: 'present', awgPresharedKey: 'present' }] }) },
    publisherForCell: () => ({ load: async () => null }),
    backupForCell: cellKey => ({ grant: () => f.mainStore.grant(),
      acknowledge: ack => f.mainStore.acknowledge(cellKey, ack) }) });
  const server = await listenControlOnTunnel({ address: '127.0.0.1', port: 0, handler: service });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await syncCellSettings({ connectionStore: { filePath: path.join(f.directory, 'connection.json'),
    read: async () => ({ ...f.trust, version: 2, status: 'registered' }) },
  identityStore: { load: async () => f.cell }, receiver: {}, host: '127.0.0.1', port: server.address().port,
  transport: 'tunnel' });
  assert.equal(result.status, 'no-settings');
  assert.deepEqual(await f.mainStore.status(f.cell.publicKey), { generation: 1, confirmed: true });
  assert.equal((await f.store.read()).grant.archiveHash, f.grant.archiveHash);
});

test('Cell automatically proves takeover on real control RPC and rejects old Main replies and replayed old acknowledgements', async t => {
  const f = await fixture(t);
  await f.mainStore.commit(f.grant, [f.cell.publicKey]);
  await f.store.accept(f.grant);
  const oldAck = await f.store.acknowledgement(f.cell.privateKey);
  const restoration = new MainBackupRecovery(path.join(f.directory, 'restore-recovery.json'), f.main.publicKey);
  await restoration.journal.write({ version: 1, grant: f.grant, material: f.material });
  let currentAuthority = f.authority;
  const connectionStore = { filePath: path.join(f.directory, 'connection.json'),
    read: async () => ({ ...f.trust, version: 2, status: 'registered' }) };
  const receiver = new CellSettingsReceiver(path.join(f.directory, 'received-settings.json'), {
    ...f.trust, authority: () => epochFor(connectionStore), apply: async () => {} });
  await receiver.receive(signSettings({ cellKey: f.cell.publicKey, revision: 10,
    settings: { schema: 1, clients: [] } }, f.main.privateKey));
  const publisher = new CellSettingsPublisher(path.join(f.directory, 'published-settings.json'),
    { load: async () => f.main }, f.cell.publicKey);
  await publisher.publish({ schema: 1, clients: [] });
  const service = new CellControlService({ identityStore: { load: async () => f.main },
    bootstrapStore: { read: async () => ({ version: 2, invitations: [{ status: 'consumed', phase: 'closed',
      cellKey: f.cell.publicKey, awgPublicKey: 'present', awgPresharedKey: 'present' }] }) },
    publisherForCell: () => publisher, authorityIdentity: async () => currentAuthority,
    recoveryForCell: (cellKey, challenge) => restoration.proof({ cellKey, challenge, grant: f.grant,
      authority: f.authority, endpointHost: '198.51.100.50' }),
    backupForCell: cellKey => ({ grant: () => f.mainStore.grant(cellKey),
      acknowledge: ack => f.mainStore.acknowledge(cellKey, ack, f.authority.publicKey) }) });
  const server = await listenControlOnTunnel({ address: '127.0.0.1', port: 0, handler: service });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { connectionStore, identityStore: { load: async () => f.cell }, receiver,
    host: '127.0.0.1', port: server.address().port, transport: 'tunnel' };
  assert.equal((await syncCellSettings(options)).status, 'applied');
  assert.equal((await receiver.load()).applied.revision, 1);
  assert.equal((await receiver.load()).appliedGeneration, 1);
  assert.equal((await f.store.read()).authority.proof.authorityKey, f.authority.publicKey);
  assert.equal((await f.mainStore.read()).acks[0].authorityKey, f.authority.publicKey);
  await assert.rejects(f.mainStore.acknowledge(f.cell.publicKey, oldAck, f.authority.publicKey));
  currentAuthority = null;
  await assert.rejects(syncCellSettings(options), /rejected/);
  assert.equal((await f.store.read()).authority.proof.authorityKey, f.authority.publicKey);
  currentAuthority = f.authority;
  assert.equal((await syncCellSettings(options)).status, 'applied');
});

test('a new Cell pins live authority from its signed AWG registration receipt and can immediately poll restored Main', async t => {
  const f = await fixture(t);
  const identityStore = { load: async () => f.cell };
  const bootstrapStore = new CellAwgBootstrapStore(path.join(f.directory, 'bootstrap.json'));
  const owned = { load: async () => ({ phase: 'ready', spec: {
    owner: { interfaceName: 'testawg' }, addresses: ['127.0.0.1/32'] } }), verify: async () => ({ up: true }) };
  const registration = await listenAwgRegistrationOnTunnel({ address: '127.0.0.1', port: 0,
    lifecycle: owned, identityStore: { load: async () => f.main }, bootstrapStore,
    authorityIdentity: async () => f.authority, bootstrapRuntime: { store: bootstrapStore,
      lifecycle: owned, controllerAddress: '127.0.0.1', registrationPort: 0, verifyCurrent: async () => true } });
  t.after(() => new Promise(resolve => registration.close(resolve)));
  const profile = generateOfficialProfile();
  const serverPublicKey = awgKeys().publicKey;
  const issued = await createAwgBootstrapInvitation({ controllerKey: f.main.publicKey,
    endpointHost: '198.51.100.1', endpointPort: 53081, registrationPort: registration.address().port,
    controllerAddress: '10.90.0.1', cellAddress: '10.90.0.2', serverPublicKey,
    profile, keyManager: { generatePeerKeys: async () => ({ ...awgKeys(), presharedKey: crypto.randomBytes(32).toString('base64') }) },
    permanentDescriptor: { version: 1, endpointHost: '198.51.100.1', endpointPort: 53084,
      controllerAddress: '10.91.0.1', cellAddress: '10.91.0.2', controlPort: 53083,
      serverPublicKey, profile } });
  await bootstrapStore.reserve(issued.record);
  await bootstrapStore.markReady(issued.record.id);
  // The invitation deliberately pins a private real loopback transport in the
  // test. Production invitation validation disallows loopback, so use the
  // standard adapter while selecting only its destination locally.
  const { registerAwgOverTunnel } = require('../lib/CellTunnelRegistrationTransport');
  const store = new CellAwgConnectionStore(path.join(f.directory, 'fresh-connection.json'), identityStore,
    { keyManager: { generatePeerKeys: async () => ({ ...awgKeys(), presharedKey: crypto.randomBytes(32).toString('base64') }) },
      connect: options => registerAwgOverTunnel({ ...options, address: '127.0.0.1' }) });
  await store.begin(issued.code);
  await store.resume();
  assert.equal((await store.read()).authorityKey, f.authority.publicKey);
  const service = new CellControlService({ identityStore: { load: async () => f.main },
    bootstrapStore: { read: async () => ({ version: 2, invitations: [{ status: 'consumed', phase: 'closed',
      cellKey: f.cell.publicKey, awgPublicKey: 'present', awgPresharedKey: 'present' }] }) },
    publisherForCell: () => ({ load: async () => null }), authorityIdentity: async () => f.authority });
  const control = await listenControlOnTunnel({ address: '127.0.0.1', port: 0, handler: service });
  t.after(() => new Promise(resolve => control.close(resolve)));
  assert.equal((await syncCellSettings({ connectionStore: store, identityStore, receiver: {},
    host: '127.0.0.1', port: control.address().port, transport: 'tunnel' })).status, 'no-settings');
  const nextAuthority = identity();
  await store.pinAuthority(nextAuthority.publicKey, 2);
  assert.deepEqual(await epochFor(store), { key: nextAuthority.publicKey, generation: 2 });
  await assert.rejects(store.pinAuthority(f.authority.publicKey, 1), /Stale/);
  await assert.rejects(store.pinAuthority(f.authority.publicKey, 2), /conflicting/);
});
test('backup files are durable before generation publication; only recovery material in encrypted archive can prove takeover', async t => {
  const f = await fixture(t);
  const panel = path.join(f.directory, 'panel');
  await fs.mkdir(panel, { mode: 0o700 });
  await new StateStore(path.join(panel, 'state.json')).save({ version: 3,
    auth: { passwordHash: 'password-hash', sessionSecret: 'session-secret' },
    server: { interfaceName: 'awg0', wanInterface: 'eth0', endpointHost: '198.51.100.1',
      listenPort: 51820, panelPort: 51821, ...awgKeys(),
      address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24', profile: generateOfficialProfile() },
    clients: [{ id: 'admin', name: 'Home admin', networkGroup: 'home', enabled: true,
      address4: '10.8.0.2', ...awgKeys(), presharedKey: crypto.randomBytes(32).toString('base64') }] });
  const outputDirectory = path.join(f.directory, 'backups');
  let committed = false;
  const options = { panelDirectory: panel, outputDirectory, identity: f.main,
    generationStore: { grant: () => f.mainStore.grant(), commit: async grant => {
      const [id] = await fs.readdir(outputDirectory);
      const archive = await fs.readFile(path.join(outputDirectory, id, 'configuration.awgbackup'));
      const key = (await fs.readFile(path.join(outputDirectory, id, 'recovery-key.txt'), 'utf8')).trim();
      const snapshot = decodeConfiguration(archive, key);
      assert.equal(snapshot.recovery.publicKey, grant.recoveryKey);
      assert.equal(snapshot.recovery.generation, grant.generation);
      assert.equal(crypto.createHash('sha256').update(archive).digest('hex'), grant.archiveHash);
      assert.equal(archive.includes(Buffer.from('PRIVATE KEY')), false);
      committed = true;
      return f.mainStore.commit(grant, [f.cell.publicKey]);
    } }, withQuiesced: work => work() };
  const saved = await createConfigurationBackup(options);
  assert.equal(committed, true);
  const snapshot = decodeConfiguration(Buffer.from(saved.archive, 'base64'), saved.recoveryKey);
  assert.equal(snapshot.recovery.generation, 1);
  assert.equal(saved.generation, 1);
  await f.store.accept(await f.mainStore.grant());
  const challenge = await f.store.challenge();
  const proof = signTakeover({ grant: await f.mainStore.grant(), material: snapshot.recovery,
    cellKey: f.cell.publicKey, challenge: challenge.nonce,
    authorityKey: f.authority.publicKey, endpointHost: '198.51.100.44' });
  assert.equal((await f.store.consume(proof)).endpointHost, '198.51.100.44');
  const blocked = path.join(f.directory, 'not-a-directory');
  await fs.writeFile(blocked, 'preserve');
  await assert.rejects(createConfigurationBackup({ ...options, outputDirectory: blocked }));
  assert.equal((await f.mainStore.grant()).generation, 1);
  assert.equal(await fs.readFile(blocked, 'utf8'), 'preserve');
});
