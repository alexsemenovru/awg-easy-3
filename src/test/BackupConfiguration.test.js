'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { openMainBootstrapInstallationHost } = require('../lib/MainBootstrapInstallationHost');
const { decodeConfiguration } = require('../lib/BackupSnapshot');
const { MainBackupStore } = require('../lib/MainBackupStore');
const { MainBackupRecovery } = require('../lib/MainBackupRecovery');
const { CellBackupRecoveryStore } = require('../lib/CellBackupRecoveryStore');
const { ControlIdentityStore } = require('../lib/ControlIdentityStore');
const { createRecoveryMaterial } = require('../lib/BackupRecovery');
const { sealBackup } = require('../lib/BackupEnvelope');
const { prepareConfigurationRestore, inspectPreparedRestore } = require('../lib/ConfigurationRestore');
const { runRestoreCli } = require('../lib/RestoreCli');
const { verifyMainRestoreBootstrap } = require('../lib/MainRestoreBootstrap');
const { openInstallationRestore } = require('../lib/InstallationRestore');
const { StateStore } = require('../lib/StateStore');
const { identity } = require('../lib/CellRegistration');
const { deriveAwgPublicKey } = require('../lib/CellAwgConnectionStore');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { validateBackupConfiguration } = require('../lib/BackupConfigurationValidator');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
const { CellAwgPermanentRevisionStore } = require('../lib/CellAwgPermanentRevisionStore');
const { controllerDataLinkPlan } = require('../lib/CellDataLinkPlan');
const { signSettings } = require('../lib/CellSettings');
const { fixture, key, pair, keyManager, hash, file } = require('./helpers/BackupFixture');
function rewrite(snapshot, name, change) {
  const index = snapshot.files.findIndex(item => `${item.area}/${item.name}` === name);
  snapshot.files[index] = file(name, change(JSON.parse(Buffer.from(snapshot.files[index].data, 'base64'))));
}

test('semantic backup validation proves Main identities, two Cell peers and generated data plans without host commands', async () => {
  const snapshot = await fixture();
  assert.deepEqual(await validateBackupConfiguration(snapshot), { main: true, cells: 2, clients: 1 });
});
test('semantic backup validation rejects mismatched keys, missing revisions, altered plans and orphan Cell metadata', async () => {
  const snapshot = await fixture();
  const wrongServer = structuredClone(snapshot);
  rewrite(wrongServer, 'panel/state.json', value => ({ ...value, server: { ...value.server, publicKey: pair().publicKey } }));
  await assert.rejects(validateBackupConfiguration(wrongServer), /disagree/);
  const missingRevision = structuredClone(snapshot);
  missingRevision.files = missingRevision.files.filter(item => item.name !== 'permanent/revision.json');
  await assert.rejects(validateBackupConfiguration(missingRevision), /disagree/);
  const changedPlan = structuredClone(snapshot);
  const dataName = changedPlan.files.find(item => item.name.startsWith('data-links/')).name;
  rewrite(changedPlan, `main/${dataName}`, value => { value.spec.addresses = ['10.99.1.1/32']; return value; });
  await assert.rejects(validateBackupConfiguration(changedPlan), /disagree/);
  const changedOffer = structuredClone(snapshot);
  const offerName = changedOffer.files.find(item => item.name.startsWith('cell-data-offers/')).name;
  rewrite(changedOffer, `main/${offerName}`, value => ({ ...value, cellPublicKey: pair().publicKey }));
  await assert.rejects(validateBackupConfiguration(changedOffer), /disagree/);
  const orphan = structuredClone(snapshot);
  orphan.files.push(file(`main/cell-data-keys/${'f'.repeat(64)}.json`, { version: 1, publicKey: pair().publicKey }));
  await assert.rejects(validateBackupConfiguration(orphan), /disagree/);
  const forgedSettings = structuredClone(snapshot);
  const settingsName = forgedSettings.files.find(item => item.name.startsWith('cell-settings/')).name;
  rewrite(forgedSettings, `main/${settingsName}`, value => ({ ...value, desired: { ...value.desired, payload: '{"schema":1,"clients":[] }' } }));
  await assert.rejects(validateBackupConfiguration(forgedSettings), /Invalid/);
});

test('product Main creates a complete recoverable archive for its enrolled Cells under the installation lock', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-main-backup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshot = await fixture();
  for (const item of snapshot.files) {
    const target = path.join(directory, item.area, item.name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, Buffer.from(item.data, 'base64'), { mode: 0o600 });
  }
  let held = false;
  const host = await openMainBootstrapInstallationHost({ stateDirectory: path.join(directory, 'main'),
    userStateFile: path.join(directory, 'panel/state.json'), interfaceName: 'awgmainb0',
    controllerAddress: '10.90.8.1', registrationPort: 53082, listenPort: 53081, endpointHost: '198.51.100.1',
    permanentEndpointPort: 53084, permanentControllerAddress: '10.91.8.1', permanentControlPort: 53083,
    keyManager, prepareStateDirectory: async () => {},
    runner: async () => { throw new Error('Backup must not execute host commands'); },
    withLock: async ({ work }) => { assert.equal(held, false); held = true; try { return await work(); } finally { held = false; } },
    resources: { interfaceNames: ['awgmainb0', 'awgmainc0'], udpPorts: [53081, 53084],
      userInterfaceNames: ['awg0'], userUdpPorts: [51820], nftTables: ['awg_easy_3_bootstrap',
        'awg_easy_3_bootstrap_guard', 'awg_easy_3_control', 'awg_easy_3_control_guard'] } });
  const saved = await host.createBackup();
  const restored = decodeConfiguration(Buffer.from(saved.archive, 'base64'), saved.recoveryKey);
  assert.deepEqual(await validateBackupConfiguration(restored), { main: true, cells: 2, clients: 1 });
  assert.equal(restored.recovery.generation, 1);
  assert.equal(held, false);
  const ids = await host.identityStore.load('controller');
  const journal = await new MainBackupStore(path.join(directory, 'main/backup-state.json'), ids.publicKey).read();
  assert.equal(journal.recipients.length, 2);
  assert.equal(journal.acks.length, 0);
  const second = await host.createBackup();
  assert.equal(second.generation, 2);
  assert.notEqual(saved.recoveryKey, second.recoveryKey);
});

test('restore workspace retains identities, prepares new-host bindings and fresh fenced recovery without touching a live installation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-restore-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await fixture();
  snapshot.recovery = createRecoveryMaterial(5);
  const sealed = sealBackup(Buffer.from(JSON.stringify(snapshot)));
  const before = JSON.stringify(snapshot);
  const directory = path.join(root, 'prepared');
  const target = { interfaceName: 'awg3', wanInterface: 'ens9', endpointHost: '198.51.100.44', listenPort: 55000, panelPort: 80 };
  const result = await prepareConfigurationRestore({ archive: sealed.archive, recoveryKey: sealed.recoveryKey, target, directory });
  assert.equal(result.prepared, true);
  assert.equal(result.generation, 5);
  assert.equal(result.cells, 2);
  assert.equal(result.bindings.AWG_MAIN_CONTROL_ADDRESS, '10.91.8.1');
  assert.equal(result.bindings.AWG_MAIN_ENDPOINT, target.endpointHost);
  assert.equal(JSON.stringify(result).includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(snapshot), before);
  const panel = await new StateStore(path.join(directory, 'panel/state.json')).load();
  const originalPanel = JSON.parse(Buffer.from(snapshot.files.find(item => item.area === 'panel').data, 'base64'));
  assert.equal(panel.server.privateKey, originalPanel.server.privateKey);
  assert.equal(panel.clients[0].privateKey, originalPanel.clients[0].privateKey);
  assert.equal(panel.server.endpointHost, target.endpointHost);
  assert.notEqual(panel.auth.sessionSecret, originalPanel.auth.sessionSecret);
  const controller = await new ControlIdentityStore(path.join(directory, 'main/identity.json')).load('controller');
  const authority = await new ControlIdentityStore(path.join(directory, 'main/authority.json')).load('controller');
  assert.notEqual(authority.publicKey, controller.publicKey);
  const backupStore = new MainBackupStore(path.join(directory, 'main/backup-state.json'), controller.publicKey);
  const state = await backupStore.read();
  assert.equal(state.grant.generation, 5);
  assert.equal(state.acks.length, 0);
  assert.equal(state.recipients.length, 2);
  const cell = new CellBackupRecoveryStore(path.join(root, 'cell-recovery.json'), {
    controllerKey: controller.publicKey, cellKey: state.recipients[0] });
  await cell.accept(state.grant);
  const challenge = await cell.challenge();
  const recovery = new MainBackupRecovery(path.join(directory, 'main/restore-recovery.json'), controller.publicKey);
  const proof = await recovery.proof({ cellKey: state.recipients[0], challenge,
    grant: state.grant, authority, endpointHost: target.endpointHost });
  assert.deepEqual(await cell.consume(proof), { authorityKey: authority.publicKey, endpointHost: target.endpointHost });
  const marker = JSON.parse(await fs.readFile(path.join(directory, 'restore-prepared.json')));
  assert.equal(marker.phase, 'prepared');
  assert.equal(marker.archiveHash, hash(sealed.archive));
  assert.equal(JSON.stringify(marker).includes(snapshot.recovery.privateKey), false);
  assert.deepEqual(await inspectPreparedRestore(directory), result);
  const permitOptions = { root: path.join(directory, 'main'), userStateFile: path.join(directory, 'panel/state.json'),
    endpointHost: target.endpointHost, userInterface: target.interfaceName, userPort: target.listenPort,
    controlInterface: 'awgmainc0', controlPort: 53084, controlAddress: '10.91.8.1', controlTcpPort: 53083 };
  assert.deepEqual(await verifyMainRestoreBootstrap(permitOptions), { verified: true });
  for (const change of [{ controlPort: 53085 }, { userPort: 51820 }, { endpointHost: '198.51.100.99' },
    { controlInterface: 'other0' }, { controlAddress: '10.91.9.1' }, { controlTcpPort: 55002 }]) {
    await assert.rejects(verifyMainRestoreBootstrap({ ...permitOptions, ...change }));
  }
  // A verified import reaches the ordinary free-resource preflight; neither
  // wrong bindings nor a missing permit may run even that host inspection.
  let preflights = 0;
  const host = await openMainBootstrapInstallationHost({ stateDirectory: permitOptions.root,
    userStateFile: permitOptions.userStateFile, interfaceName: 'awgmainb0', controllerAddress: '10.90.8.1',
    registrationPort: 53082, listenPort: 53081, endpointHost: target.endpointHost,
    permanentEndpointPort: 53084, permanentControllerAddress: '10.91.8.1', permanentControlPort: 53083,
    keyManager, prepareStateDirectory: async () => {}, withLock: async ({ work }) => work(),
    preflight: async () => { preflights++; throw new Error('Reached ordinary free-resource preflight'); },
    runner: async () => { throw new Error('No host mutation allowed'); },
    resources: { interfaceNames: ['awgmainb0', 'awgmainc0'], udpPorts: [53081, 53084],
      userInterfaceNames: [target.interfaceName], userUdpPorts: [target.listenPort],
      nftTables: ['awg_easy_3_bootstrap', 'awg_easy_3_bootstrap_guard', 'awg_easy_3_control', 'awg_easy_3_control_guard'] } });
  await assert.rejects(host.resume(), /Reached ordinary/);
  assert.equal(preflights, 1);
  await fs.unlink(path.join(permitOptions.root, 'restore-bootstrap.json'));
  await assert.rejects(host.resume(), /No matching/);
  assert.equal(preflights, 1);
  await assert.rejects(prepareConfigurationRestore({ archive: sealed.archive, recoveryKey: sealed.recoveryKey, target, directory }), { code: 'EEXIST' });
});

test('restore CLI prepares and inspects a sealed Main archive without printing credentials, then rejects staged tampering', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-restore-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await fixture();
  snapshot.recovery = createRecoveryMaterial(3);
  const sealed = sealBackup(Buffer.from(JSON.stringify(snapshot)));
  const input = path.join(root, 'configuration.awgbackup'), keyFile = path.join(root, 'key.txt');
  const targetFile = path.join(root, 'target.json'), directory = path.join(root, 'prepared');
  const panel = JSON.parse(Buffer.from(snapshot.files.find(item => item.area === 'panel').data, 'base64'));
  panel.server.endpointHost = '198.51.100.55';
  await fs.writeFile(input, sealed.archive, { mode: 0o600 });
  await fs.writeFile(keyFile, sealed.recoveryKey, { mode: 0o600 });
  await fs.writeFile(targetFile, JSON.stringify(panel), { mode: 0o600 });
  let stdout = '';
  const output = { write: value => { stdout += value; } };
  await runRestoreCli({ args: ['prepare', input, keyFile, targetFile, directory], output });
  await runRestoreCli({ args: ['inspect', directory], output });
  const expected = { prepared: true, activated: false, main: true, cells: 2, clients: 1, generation: 3 };
  assert.deepEqual(stdout.trim().split('\n').map(line => JSON.parse(line)), [expected, expected]);
  for (const secret of [sealed.recoveryKey, panel.server.privateKey, snapshot.recovery.privateKey]) assert.equal(stdout.includes(secret), false);
  const markerFile = path.join(directory, 'restore-prepared.json');
  const marker = JSON.parse(await fs.readFile(markerFile));
  await fs.writeFile(markerFile, JSON.stringify({ ...marker, bindings: { ...marker.bindings, AWG_MAIN_ENDPOINT: '198.51.100.77' } }));
  await assert.rejects(inspectPreparedRestore(directory), /incomplete/);
  await fs.writeFile(markerFile, JSON.stringify(marker));
  const stateFile = path.join(directory, 'main/backup-state.json');
  const journal = JSON.parse(await fs.readFile(stateFile));
  await fs.writeFile(stateFile, JSON.stringify({ ...journal, recipients: [journal.recipients[0], identity().publicKey] }));
  await assert.rejects(inspectPreparedRestore(directory), /incomplete/);
  await fs.writeFile(stateFile, JSON.stringify(journal));
  await fs.appendFile(path.join(directory, 'panel/state.json'), ' ');
  await assert.rejects(inspectPreparedRestore(directory), /changed/);
  await assert.rejects(runRestoreCli({ args: ['prepare', input, keyFile, targetFile], output }), /Usage/);
});

test('restore CLI refuses non-private or excessive inputs before reserving output', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-restore-inputs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'archive'), directory = path.join(root, 'prepared');
  await fs.writeFile(input, Buffer.alloc(12 * 1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(runRestoreCli({ args: ['prepare', input, input, input, directory], output: { write() {} } }), /Unsafe/);
  await fs.writeFile(input, 'short');
  if (process.platform !== 'win32') {
    await fs.chmod(input, 0o644);
    await assert.rejects(runRestoreCli({ args: ['prepare', input, input, input, directory], output: { write() {} } }), /Unsafe/);
  }
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('restore preparation supports standalone panels and Main Nodes with no enrolled Cells', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-restore-empty-main-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = { interfaceName: 'awg3', wanInterface: 'ens9', endpointHost: '198.51.100.44', listenPort: 55000, panelPort: 80 };
  for (const main of [false, true]) {
    const snapshot = await fixture();
    snapshot.files = snapshot.files.filter(item => item.area === 'panel' || main
      && ['identity.json', 'config.json', 'bootstrap.json'].includes(item.name));
    if (main) {
      snapshot.recovery = createRecoveryMaterial(7);
      rewrite(snapshot, 'main/bootstrap.json', value => ({ ...value, invitations: [] }));
    }
    const sealed = sealBackup(Buffer.from(JSON.stringify(snapshot)));
    const directory = path.join(root, main ? 'main' : 'panel');
    const result = await prepareConfigurationRestore({ archive: sealed.archive,
      recoveryKey: sealed.recoveryKey, target, directory });
    assert.deepEqual(await inspectPreparedRestore(directory), result);
    assert.equal(result.main, main);
    assert.equal(result.cells, 0);
    assert.equal(result.generation, main ? 7 : null);
    assert.equal(result.bindings, null);
  }
});

async function installationFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-installation-restore-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await fixture(); snapshot.recovery = createRecoveryMaterial(6);
  const bytes = Buffer.from(snapshot.files.find(item => item.area === 'panel').data, 'base64');
  const target = JSON.parse(bytes); target.server.endpointHost = '198.51.100.77';
  await fs.mkdir(path.join(root, 'data'), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'data/state.json'), JSON.stringify(target), { mode: 0o600 });
  await fs.writeFile(path.join(root, 'data/old-cache'), 'preserve the old destination exactly', { mode: 0o600 });
  const sealed = sealBackup(Buffer.from(JSON.stringify(snapshot)));
  const dependencies = { runner: async () => ({ stdout: '[]' }), preflight: async () => {}, ...options };
  // Socket inventory is plain text, route inventory is JSON.
  const run = dependencies.runner;
  dependencies.runner = async (command, ...args) => command === 'ss' ? { stdout: '' } : run(command, ...args);
  const operation = await openInstallationRestore(root, dependencies);
  const prepare = () => operation.prepare({ ...sealed, image: `sha256:${'a'.repeat(64)}` });
  return { root, sealed, dependencies, operation, prepare, target };
}

test('installation restore retains previous destination data and commits all Main paths with fresh target bindings', async t => {
  const f = await installationFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.phase, 'prepared');
  assert.equal(await fs.readFile(path.join(f.root, 'data/old-cache'), 'utf8'), 'preserve the old destination exactly');
  await f.operation.commit();
  assert.equal((await f.operation.status()).phase, 'committed');
  const panel = await new StateStore(path.join(f.root, 'data/state.json')).load();
  assert.equal(panel.server.endpointHost, f.target.server.endpointHost);
  const environment = await fs.readFile(path.join(f.root, '.env.cells-main'), 'utf8');
  assert.match(environment, /AWG_MAIN_CONTROL_PORT=53084\n/);
  assert.match(environment, /AWG_MAIN_ENDPOINT=198\.51\.100\.77\n/);
  assert.equal(await fs.readFile(path.join(f.root, '.restore', prepared.id, 'previous/data/old-cache'), 'utf8'), 'preserve the old destination exactly');
  await f.operation.start();
  await assert.rejects(f.operation.rollback(), /after service startup/);
  await f.operation.complete();
  assert.equal((await f.operation.status()).phase, 'complete');
});

test('installation restore resumes a rename completed before journal update and rolls back before startup', async t => {
  let count = 0;
  const f = await installationFixture(t, { rename: async (a, b) => {
    await fs.rename(a, b); if (++count === 3) throw new Error('simulated process loss after rename');
  } });
  await f.prepare();
  await assert.rejects(f.operation.commit(), /simulated/);
  assert.equal((await f.operation.status()).phase, 'switching');
  const recovered = await openInstallationRestore(f.root, { ...f.dependencies, rename: fs.rename });
  await recovered.commit();
  assert.equal((await recovered.status()).phase, 'committed');
  await recovered.rollback();
  assert.equal((await recovered.status()).phase, 'rolled-back');
  assert.equal(await fs.readFile(path.join(f.root, 'data/old-cache'), 'utf8'), 'preserve the old destination exactly');
  await assert.rejects(fs.stat(path.join(f.root, '.env.cells-main')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.root, 'cell-data')), { code: 'ENOENT' });
});

test('restore rejects a changed destination, occupied host resources and an existing Cell network before moving data', async t => {
  const f = await installationFixture(t);
  await f.prepare();
  await fs.appendFile(path.join(f.root, 'data/state.json'), ' ');
  await assert.rejects(f.operation.commit(), /configuration changed/);
  await f.operation.rollback();
  await fs.mkdir(path.join(f.root, 'cell-data'), { mode: 0o700 });
  await assert.rejects(f.prepare(), /without a Cell network/);
  const occupied = await installationFixture(t);
  await occupied.prepare();
  const guarded = await openInstallationRestore(occupied.root, { ...occupied.dependencies,
    preflight: async () => { throw new Error('resource occupied'); } });
  await assert.rejects(guarded.commit(), /occupied/);
  assert.equal(await fs.readFile(path.join(occupied.root, 'data/old-cache'), 'utf8'), 'preserve the old destination exactly');
});

test('bad archive/key or conflicting new-host bindings cannot create an activatable restore workspace', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-restore-reject-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await fixture();
  snapshot.recovery = createRecoveryMaterial(2);
  const sealed = sealBackup(Buffer.from(JSON.stringify(snapshot)));
  const target = { interfaceName: 'awg3', wanInterface: 'ens9', endpointHost: '198.51.100.44', listenPort: 55000, panelPort: 80 };
  const directory = path.join(root, 'rejected');
  await assert.rejects(prepareConfigurationRestore({ archive: sealed.archive,
    recoveryKey: sealBackup(Buffer.from('different')).recoveryKey, target, directory }));
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  await assert.rejects(prepareConfigurationRestore({ archive: sealed.archive,
    recoveryKey: sealed.recoveryKey, target: { ...target, listenPort: 53084 }, directory }), /conflict/);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  await assert.rejects(prepareConfigurationRestore({ archive: sealed.archive,
    recoveryKey: sealed.recoveryKey, target, directory, now: () => NaN }));
  await assert.rejects(fs.stat(path.join(directory, 'restore-prepared.json')), { code: 'ENOENT' });
});

test('prepared Main reconstructs fresh real AWG bootstrap/control journals and resumes without replacing enrollment',
  { skip: process.env.AWG_RESTORE_KERNEL_TEST !== '1' }, async t => {
    assert.equal(process.platform, 'linux');
    assert.equal(process.env.AWG_DISPOSABLE_NETWORK_TEST, '1');
    await fs.access('/.dockerenv'); // Never execute this against a working host.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-restore-kernel-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const snapshot = await fixture();
    snapshot.recovery = createRecoveryMaterial(4);
    const sealed = sealBackup(Buffer.from(JSON.stringify(snapshot)));
    const directory = path.join(root, 'prepared');
    const target = { interfaceName: 'awg3', wanInterface: 'eth0', endpointHost: '198.51.100.88', listenPort: 55000, panelPort: 80 };
    await prepareConfigurationRestore({ archive: sealed.archive, recoveryKey: sealed.recoveryKey, target, directory });
    const stateDirectory = path.join(directory, 'main');
    const host = await openMainBootstrapInstallationHost({ stateDirectory,
      userStateFile: path.join(directory, 'panel/state.json'), interfaceName: 'awgmainb0', controllerAddress: '10.90.8.1',
      registrationPort: 53082, listenPort: 53081, endpointHost: target.endpointHost,
      permanentEndpointPort: 53084, permanentControllerAddress: '10.91.8.1', permanentControlPort: 53083,
      resources: { interfaceNames: ['awgmainb0', 'awgmainc0'], udpPorts: [53081, 53084],
        userInterfaceNames: [target.interfaceName], userUdpPorts: [target.listenPort],
        nftTables: ['awg_easy_3_bootstrap', 'awg_easy_3_bootstrap_guard', 'awg_easy_3_control', 'awg_easy_3_control_guard'] } });
    assert.deepEqual(await host.resume(), { ready: true, role: 'controller' });
    assert.equal((await host.recoverPermanentBoot()).configured, true);
    const first = await host.bootstrap.lifecycle.load();
    assert.equal(first.phase, 'ready');
    const { runProcess } = require('../lib/ProcessRunner');
    const peers = (await runProcess('awg', ['show', 'awgmainc0', 'peers'])).stdout.trim().split(/\s+/);
    assert.equal(peers.length, 2);
    // Once journaled, normal reboot/restart recovery uses the new ownership,
    // not the import permit or the archived owner UUIDs.
    await assert.rejects(fs.stat(path.join(stateDirectory, 'restore-bootstrap.json')), { code: 'ENOENT' });
    await host.resume();
    assert.equal((await host.recoverPermanentBoot()).configured, true);
    assert.deepEqual((await host.bootstrap.lifecycle.load()).spec.owner, first.spec.owner);
    assert.equal((await host.bootstrapStore.read()).invitations.filter(item => item.status === 'consumed').length, 2);
  });
