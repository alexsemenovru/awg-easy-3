'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { BackupJournal, syncDirectory } = require('./BackupJournal');
const { readSnapshotFile, allowedSnapshotFile } = require('./BackupSnapshot');
const { validateBackupConfiguration } = require('./BackupConfigurationValidator');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fields = ['version', 'endpointHost', 'userInterface', 'userPort', 'files'];
function validate(value) {
  if (!value || Object.keys(value).sort().join(',') !== fields.slice().sort().join(',')
    || value.version !== 1 || typeof value.endpointHost !== 'string'
    || typeof value.userInterface !== 'string' || !Number.isSafeInteger(value.userPort)
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 2048) throw new Error('Invalid restored bootstrap permit');
  const seen = new Set();
  for (const item of value.files) {
    if (!item || Object.keys(item).sort().join(',') !== 'name,sha256'
      || !allowedSnapshotFile('main', item.name) || !/^[a-f0-9]{64}$/.test(item.sha256)
      || seen.has(item.name)) throw new Error('Invalid restored bootstrap inventory');
    seen.add(item.name);
  }
  return value;
}
const journal = root => new BackupJournal(path.join(root, 'restore-bootstrap.json'), validate, 512 * 1024);
async function prepareMainRestoreBootstrap(root, snapshot, panel) {
  return journal(root).write({ version: 1, endpointHost: panel.server.endpointHost,
    userInterface: panel.server.interfaceName, userPort: panel.server.listenPort,
    files: snapshot.files.filter(item => item.area === 'main').map(({ name, sha256 }) => ({ name, sha256 })) });
}
// A missing kernel journal is normally fatal. Only this explicitly prepared,
// hash-checked logical import may reconstruct a fresh bootstrap device. The
// ordinary host preflight and guarded provisioner still run afterwards.
async function verifyMainRestoreBootstrap({ root, userStateFile, endpointHost,
  userInterface, userPort, controlInterface, controlPort, controlAddress, controlTcpPort }) {
  const permit = await journal(root).read();
  if (!permit || !userStateFile || permit.endpointHost !== endpointHost
    || permit.userInterface !== userInterface || permit.userPort !== userPort) throw new Error('No matching restored bootstrap permit');
  const files = [];
  for (const item of permit.files) {
    const bytes = await readSnapshotFile(root, item.name);
    if (hash(bytes) !== item.sha256) throw new Error('Restored bootstrap configuration changed');
    files.push({ area: 'main', ...item, data: bytes.toString('base64') });
  }
  const panel = await readSnapshotFile(path.dirname(userStateFile), path.basename(userStateFile));
  files.push({ area: 'panel', name: 'state.json', sha256: hash(panel), data: panel.toString('base64') });
  const summary = await validateBackupConfiguration({ version: 1, kind: 'awg-easy-3/configuration-snapshot', createdAt: 0, files });
  const state = JSON.parse(panel);
  if (!summary.main || state.server.endpointHost !== endpointHost
    || state.server.interfaceName !== userInterface || state.server.listenPort !== userPort) throw new Error('Restored panel bindings disagree');
  const values = new Map(files.map(item => [item.name, JSON.parse(Buffer.from(item.data, 'base64'))]));
  const records = values.get('bootstrap.json').invitations;
  if (records.some(record => record.phase !== 'closed')) throw new Error('Restored bootstrap has live invitations');
  const consumed = records.filter(record => record.status === 'consumed');
  const plan = values.get('permanent/plan.json');
  if (consumed.length && (!plan || plan.spec.owner.interfaceName !== controlInterface
    || consumed.some(record => record.permanentDescriptor.endpointHost !== endpointHost
      || record.permanentDescriptor.endpointPort !== controlPort
      || record.permanentDescriptor.controllerAddress !== controlAddress
      || record.permanentDescriptor.controlPort !== controlTcpPort))) throw new Error('Restored control bindings disagree');
  return { verified: true };
}
async function retireMainRestoreBootstrap(root) {
  await fs.unlink(path.join(root, 'restore-bootstrap.json'));
  await syncDirectory(root);
}
module.exports = { prepareMainRestoreBootstrap, verifyMainRestoreBootstrap, retireMainRestoreBootstrap };
