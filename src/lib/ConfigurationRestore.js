'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { decodeConfiguration, stageConfiguration, prepareRestoredPanelState,
  allowedSnapshotFile, readSnapshotFile } = require('./BackupSnapshot');
const { validateBackupConfiguration } = require('./BackupConfigurationValidator');
const { signBackupGrant } = require('./BackupRecovery');
const { ControlIdentityStore } = require('./ControlIdentityStore');
const { MainBackupStore } = require('./MainBackupStore');
const { MainBackupRecovery } = require('./MainBackupRecovery');
const { CellAwgPermanentRevisionStore } = require('./CellAwgPermanentRevisionStore');
const { validatePermanentPlan } = require('./CellAwgPermanentPlanStore');
const { BackupJournal, syncDirectory } = require('./BackupJournal');
const { prepareMainRestoreBootstrap, verifyMainRestoreBootstrap } = require('./MainRestoreBootstrap');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === fields.sort().join(',');
function validatePreparedMarker(value) {
  if (!exact(value, ['version', 'phase', 'archiveHash', 'generation', 'preparedAt',
    'main', 'cells', 'clients', 'authorityKey', 'bindings', 'files']) || value.version !== 1
    || value.phase !== 'prepared' || !/^[a-f0-9]{64}$/.test(value.archiveHash)
    || !Number.isSafeInteger(value.preparedAt) || value.preparedAt < 0
    || typeof value.main !== 'boolean' || !Number.isSafeInteger(value.cells) || value.cells < 0 || value.cells > 1024
    || !Number.isSafeInteger(value.clients) || value.clients < 1 || value.clients > 10000
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 2048) {
    throw new Error('Invalid restore preparation marker');
  }
  if (value.main ? !Number.isSafeInteger(value.generation) || value.generation < 1
    || typeof value.authorityKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.authorityKey)
    || Buffer.from(value.authorityKey, 'base64url').toString('base64url') !== value.authorityKey
    : value.authorityKey !== null || value.generation !== null || value.cells !== 0 || value.bindings !== null) {
    throw new Error('Invalid prepared restore authority');
  }
  const names = new Set();
  for (const item of value.files) {
    if (!exact(item, ['area', 'name', 'sha256']) || !allowedSnapshotFile(item.area, item.name)
      || !/^[a-f0-9]{64}$/.test(item.sha256) || names.has(`${item.area}/${item.name}`)) throw new Error('Invalid restore file manifest');
    names.add(`${item.area}/${item.name}`);
  }
  return value;
}
function rewrittenFile(item, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { ...item, sha256: hash(bytes), data: bytes.toString('base64') };
}
const freshOwner = plan => ({ ...plan, spec: { ...plan.spec, owner: {
  ...plan.spec.owner, ownerTag: `awg-easy-3-cell:${crypto.randomUUID()}` } } });
function mainBindings(panel, plan, records) {
  if (!plan) return null;
  const descriptor = records[0].permanentDescriptor;
  return { AWG_MAIN_ENDPOINT: panel.server.endpointHost, AWG_MAIN_USER_INTERFACE: panel.server.interfaceName,
    AWG_MAIN_USER_PORT: String(panel.server.listenPort), AWG_MAIN_CONTROL_INTERFACE: plan.spec.owner.interfaceName,
    AWG_MAIN_CONTROL_PORT: String(descriptor.endpointPort), AWG_MAIN_CONTROL_ADDRESS: descriptor.controllerAddress,
    AWG_MAIN_CONTROL_TCP_PORT: String(descriptor.controlPort) };
}

// Prepares a COMPLETE private workspace for the host installer, never mounts or
// activates it. The host must subsequently back up its old installation, prove
// free/owned kernel resources, quiesce services and perform a journaled swap.
// A staging-complete marker alone does not authorize activation: require the
// final restore-prepared marker written only after all recovery state is durable.
async function prepareConfigurationRestore({ archive, recoveryKey, target, directory, now = Date.now }) {
  const original = decodeConfiguration(archive, recoveryKey);
  const summary = await validateBackupConfiguration(original);
  const restored = structuredClone(original);
  const originalFiles = new Map(original.files.map(item => [`${item.area}/${item.name}`,
    JSON.parse(Buffer.from(item.data, 'base64').toString('utf8'))]));
  const panel = prepareRestoredPanelState(original, target);
  const updates = new Map([['panel/state.json', panel]]);
  let bindings = null, recipients = [];
  if (summary.main) {
    if (!original.recovery) throw new Error('This Main backup has no recovery authority');
    const enrollment = structuredClone(originalFiles.get('main/bootstrap.json'));
    for (const record of enrollment.invitations) {
      if (record.status === 'pending') {
        record.status = 'revoked'; record.phase = 'closed'; record.temporaryPresharedKey = null;
        record.changedAt = Math.max(now(), record.createdAt);
      }
      if (record.permanentDescriptor) record.permanentDescriptor.endpointHost = target.endpointHost;
    }
    const records = enrollment.invitations.filter(record => record.status === 'consumed');
    recipients = records.map(record => record.cellKey);
    updates.set('main/bootstrap.json', enrollment);
    const base = originalFiles.get('main/permanent/plan.json');
    const interfaces = new Set([target.interfaceName, target.wanInterface]);
    const usedUdp = new Set([target.listenPort]);
    if (base) {
      const revision = new CellAwgPermanentRevisionStore(path.resolve('restore-validation.json'), base)
        .validate(originalFiles.get('main/permanent/revision.json'));
      const active = validatePermanentPlan(freshOwner(revision.committed ?? base));
      if (interfaces.has(active.spec.owner.interfaceName)) throw new Error('Restored control interface conflicts with the new host');
      interfaces.add(active.spec.owner.interfaceName);
      const descriptor = records[0].permanentDescriptor;
      if (usedUdp.has(descriptor.endpointPort) || target.panelPort === descriptor.controlPort) {
        throw new Error('Restored control ports conflict with the new panel');
      }
      usedUdp.add(descriptor.endpointPort);
      // Collapse to the LAST committed peer set, never the archived first-Cell
      // base which could resurrect a revoked peer. New host gets fresh owners.
      updates.set('main/permanent/plan.json', active);
      updates.set('main/permanent/revision.json', new CellAwgPermanentRevisionStore(
        path.resolve('restore-validation.json'), active).empty());
      bindings = mainBindings(panel, active, records);
    }
    for (const [name, value] of originalFiles) {
      if (!/^main\/data-links\/[a-f0-9]{64}\/plan\.json$/.test(name)) continue;
      const interfaceName = value.spec.owner.interfaceName;
      const port = Number(value.spec.owner.config.match(/^ListenPort\s*=\s*(\d+)/m)?.[1]);
      if (interfaces.has(interfaceName) || usedUdp.has(port)) throw new Error('Restored data link conflicts with the new host');
      interfaces.add(interfaceName); usedUdp.add(port);
      updates.set(name, freshOwner(value));
    }
  }
  restored.files = restored.files.map(item => {
    const name = `${item.area}/${item.name}`;
    return updates.has(name) ? rewrittenFile(item, updates.get(name)) : item;
  });
  await validateBackupConfiguration(restored);
  await stageConfiguration(restored, directory);
  let authority = null;
  if (summary.main) {
    const mainDirectory = path.join(directory, 'main');
    const controller = await new ControlIdentityStore(path.join(mainDirectory, 'identity.json')).load('controller');
    authority = await new ControlIdentityStore(path.join(mainDirectory, 'authority.json')).create('controller');
    const grant = signBackupGrant(original.recovery, archive, controller.privateKey);
    const state = new MainBackupStore(path.join(mainDirectory, 'backup-state.json'), controller.publicKey);
    // Initialization in a NEW, private workspace only. Ordinary commit() still
    // permits exactly +1, while this validated imported generation may be >1.
    await state.journal.write({ version: 1, grant, recipients, acks: [] });
    await new MainBackupRecovery(path.join(mainDirectory, 'restore-recovery.json'), controller.publicKey)
      .journal.write({ version: 1, grant, material: original.recovery });
    await prepareMainRestoreBootstrap(mainDirectory, restored, panel);
  }
  const marker = { version: 1, phase: 'prepared', archiveHash: hash(archive),
    generation: original.recovery?.generation ?? null, preparedAt: now(),
    main: summary.main, cells: summary.cells, clients: summary.clients,
    authorityKey: authority?.publicKey ?? null, bindings,
    files: [] };
  for (const item of restored.files) marker.files.push({ area: item.area, name: item.name, sha256: item.sha256 });
  // The final marker is private and deliberately contains no recovery secret,
  // session cookie, client identity, profile name or client traffic metadata.
  await new BackupJournal(path.join(directory, 'restore-prepared.json'), validatePreparedMarker, 512 * 1024).write(marker);
  await syncDirectory(directory);
  // Keys are in private staged files only, never return them to CLI logs/UI.
  return { prepared: true, main: summary.main, cells: summary.cells,
    clients: summary.clients, generation: marker.generation, bindings };
}

async function inspectPreparedRestore(directory) {
  if (!path.isAbsolute(directory)) throw new TypeError('Absolute restore workspace required');
  const marker = await new BackupJournal(path.join(directory, 'restore-prepared.json'),
    validatePreparedMarker, 512 * 1024).read();
  if (!marker) throw new Error('Restore preparation is incomplete');
  const files = [];
  let total = 0;
  for (const item of marker.files) {
    const bytes = await readSnapshotFile(path.join(directory, item.area), item.name);
    if (hash(bytes) !== item.sha256) throw new Error('Prepared restore file changed');
    total += bytes.length;
    if (total > 8 * 1024 * 1024) throw new Error('Prepared restore exceeds the size limit');
    files.push({ ...item, data: bytes.toString('base64') });
  }
  const summary = await validateBackupConfiguration({ version: 1,
    kind: 'awg-easy-3/configuration-snapshot', createdAt: marker.preparedAt, files });
  if (summary.main !== marker.main || summary.cells !== marker.cells || summary.clients !== marker.clients) {
    throw new Error('Prepared restore summary disagrees with its files');
  }
  if (summary.main) {
    const root = path.join(directory, 'main');
    const controller = await new ControlIdentityStore(path.join(root, 'identity.json')).load('controller');
    const authority = await new ControlIdentityStore(path.join(root, 'authority.json')).load('controller');
    const state = await new MainBackupStore(path.join(root, 'backup-state.json'), controller.publicKey).read();
    const recovery = await new MainBackupRecovery(path.join(root, 'restore-recovery.json'), controller.publicKey).journal.read();
    const values = new Map(files.map(item => [`${item.area}/${item.name}`, JSON.parse(Buffer.from(item.data, 'base64'))]));
    const records = values.get('main/bootstrap.json').invitations.filter(record => record.status === 'consumed');
    const recipients = records.map(record => record.cellKey).sort();
    const bindings = mainBindings(values.get('panel/state.json'), values.get('main/permanent/plan.json'), records);
    if (!state || !recovery || authority.publicKey !== marker.authorityKey
      || state.grant.generation !== marker.generation || state.grant.archiveHash !== marker.archiveHash
      || JSON.stringify(state.grant) !== JSON.stringify(recovery.grant) || state.acks.length
      || JSON.stringify([...state.recipients].sort()) !== JSON.stringify(recipients)
      || JSON.stringify(marker.bindings) !== JSON.stringify(bindings)) throw new Error('Prepared recovery state is incomplete');
    const panel = values.get('panel/state.json');
    await verifyMainRestoreBootstrap({ root, userStateFile: path.join(directory, 'panel/state.json'),
      endpointHost: panel.server.endpointHost, userInterface: panel.server.interfaceName,
      userPort: panel.server.listenPort, controlInterface: bindings?.AWG_MAIN_CONTROL_INTERFACE,
      controlPort: Number(bindings?.AWG_MAIN_CONTROL_PORT), controlAddress: bindings?.AWG_MAIN_CONTROL_ADDRESS,
      controlTcpPort: Number(bindings?.AWG_MAIN_CONTROL_TCP_PORT) });
  }
  return { prepared: true, ...summary, generation: marker.generation, bindings: marker.bindings };
}
module.exports = { prepareConfigurationRestore, inspectPreparedRestore };
