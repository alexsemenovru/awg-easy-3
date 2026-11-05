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
const { identity } = require('../lib/CellRegistration');
const { deriveAwgPublicKey } = require('../lib/CellAwgConnectionStore');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { validateBackupConfiguration } = require('../lib/BackupConfigurationValidator');
const { createAwgBootstrapInvitation } = require('../lib/CellAwgBootstrapInvitation');
const { permanentControllerPlan } = require('../lib/CellAwgPermanentPlan');
const { CellAwgPermanentRevisionStore } = require('../lib/CellAwgPermanentRevisionStore');
const { controllerDataLinkPlan } = require('../lib/CellDataLinkPlan');
const { signSettings } = require('../lib/CellSettings');
const key = () => crypto.randomBytes(32).toString('base64');
const pair = () => { const privateKey = key(); return { privateKey, publicKey: deriveAwgPublicKey(privateKey) }; };
const keyManager = { derivePublicKey: async value => deriveAwgPublicKey(value),
  generateKeyPair: async () => pair(),
  generatePeerKeys: async () => ({ ...pair(), presharedKey: key() }) };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function file(name, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const [area, ...parts] = name.split('/');
  return { area, name: parts.join('/'), sha256: hash(bytes), data: bytes.toString('base64') };
}
function rewrite(snapshot, name, change) {
  const index = snapshot.files.findIndex(item => `${item.area}/${item.name}` === name);
  snapshot.files[index] = file(name, change(JSON.parse(Buffer.from(snapshot.files[index].data, 'base64'))));
}
async function fixture() {
  const main = identity(), control = pair(), profile = generateOfficialProfile();
  const state = { version: 4, auth: { passwordHash: 'test-hash', sessionSecret: 'test-session' },
    server: { interfaceName: 'awg0', wanInterface: 'eth0', endpointHost: '198.51.100.1',
      listenPort: 51820, panelPort: 51821, ...pair(), address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24', profile },
    clients: [{ id: 'admin', name: 'Home admin', ...pair(), presharedKey: key(),
      networkGroup: 'home', enabled: true, address4: '10.8.0.2' }] };
  const values = { 'panel/state.json': state,
    'main/identity.json': { version: 1, role: 'controller', ...main },
    'main/config.json': { version: 1, ...control, profile } };
  const records = [];
  for (let index = 0; index < 2; index++) {
    const cell = identity(), cellAwg = pair();
    const descriptor = { version: 1, endpointHost: '198.51.100.1', endpointPort: 53084,
      controllerAddress: '10.91.8.1', cellAddress: `10.91.8.${index + 2}`, controlPort: 53083,
      serverPublicKey: control.publicKey, profile };
    const issued = await createAwgBootstrapInvitation({ controllerKey: main.publicKey,
      endpointHost: '198.51.100.1', endpointPort: 53081, registrationPort: 53082,
      controllerAddress: '10.90.8.1', cellAddress: `10.90.8.${index + 2}`,
      serverPublicKey: control.publicKey, profile, keyManager, now: 1000,
      permanentDescriptor: descriptor });
    const record = { ...issued.record, status: 'consumed', phase: 'closed',
      temporaryPresharedKey: null, cellKey: cell.publicKey, requestId: 'a'.repeat(32),
      changedAt: 1001, awgPublicKey: cellAwg.publicKey, awgPresharedKey: key() };
    records.push(record);
    const digest = hash(cell.publicKey);
    values[`main/cell-settings/${digest}.json`] = { version: 1,
      desired: signSettings({ cellKey: cell.publicKey, revision: 1, settings: { schema: 1, clients: [] } }, main.privateKey),
      ack: null, confirmed: null };
    const data = pair(), cellData = pair();
    const offer = { version: 1, controllerPrivateKey: data.privateKey,
      cellPublicKey: cellData.publicKey, presharedKey: key(), descriptor: {
        version: 1, slot: index, endpointHost: '198.51.100.1', endpointPort: 54000 + index,
        controllerAddress4: `10.92.${index}.1`, cellAddress4: `10.92.${index}.2`,
        controllerPublicKey: data.publicKey, controllerClientSubnet4: '10.8.0.0/24',
        cellClientSubnet4: `10.64.${index}.0/24`, profile } };
    values[`main/cell-data-keys/${digest}.json`] = { version: 1, publicKey: cellData.publicKey };
    values[`main/cell-data-offers/${digest}.json`] = offer;
    values[`main/data-links/${digest}/plan.json`] = (await controllerDataLinkPlan({ storedOffer: offer,
      slot: index, keyManager })).plan;
  }
  values['main/bootstrap.json'] = { version: 2, invitations: records };
  const generated = await permanentControllerPlan({ privateKey: control.privateKey,
    descriptor: records[0].permanentDescriptor, interfaceName: 'awgmainc0', keyManager,
    peers: records.map(record => ({ cellAddress: record.permanentDescriptor.cellAddress,
      awgPublicKey: record.awgPublicKey, awgPresharedKey: record.awgPresharedKey })) });
  const base = { version: 1, ...generated };
  values['main/permanent/plan.json'] = base;
  values['main/permanent/revision.json'] = new CellAwgPermanentRevisionStore(path.resolve('unused.json'), base).empty();
  return { version: 1, kind: 'awg-easy-3/configuration-snapshot', createdAt: 2000,
    files: Object.entries(values).map(([name, value]) => file(name, value)) };
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
