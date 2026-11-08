'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { captureConfiguration, decodeConfiguration, allowedSnapshotFile } = require('./BackupSnapshot');
const { validateBackupConfiguration } = require('./BackupConfigurationValidator');
const { createRecoveryMaterial, signBackupGrant } = require('./BackupRecovery');
const { privateDirectory, syncDirectory } = require('./BackupJournal');

async function snapshotInventory(mainDirectory, cellKeys = null) {
  const files = [{ area: 'panel', name: 'state.json' }];
  if (mainDirectory === null) return files;
  await privateDirectory(mainDirectory);
  const cellHashes = cellKeys === null ? null : new Set(cellKeys.map(key =>
    require('node:crypto').createHash('sha256').update(key).digest('hex')));
  // Never recurse into logs, kernel journals, caches or previously saved archives.
  for (const name of ['identity.json', 'config.json', 'bootstrap.json',
    'permanent/plan.json', 'permanent/revision.json']) {
    // With no enrolled Cells there is no permanent peer identity to restore.
    // Do not revive the historical base after its last peer was revoked.
    if (cellKeys?.length === 0 && name.startsWith('permanent/')) continue;
    try {
      const info = await fs.lstat(path.join(mainDirectory, name));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe Main backup metadata');
      files.push({ area: 'main', name });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const area of ['cell-settings', 'cell-descriptors', 'cell-data-keys', 'cell-data-offers', 'cell-routing', 'cell-maintenance', 'data-links']) {
    const directory = path.join(mainDirectory, area);
    let entries;
    try { await privateDirectory(directory); entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (entries.length > 2048) throw new Error('Too many backup source entries');
    for (const entry of entries) {
      const name = area === 'data-links' ? `${area}/${entry.name}/plan.json` : `${area}/${entry.name}`;
      if (!allowedSnapshotFile('main', name)) continue;
      if (area !== 'cell-maintenance' && cellHashes && !cellHashes.has(entry.name.split('.')[0])) continue;
      if (entry.isSymbolicLink() || (area === 'data-links' ? !entry.isDirectory() : !entry.isFile())) {
        throw new Error('Unsafe Main backup inventory');
      }
      files.push({ area: 'main', name });
    }
  }
  return files;
}
async function writeNewFile(filePath, bytes) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

// Caller holds BOTH the panel's writer queue and Main's installation flock.
// Persist archive AND separate key before advancing the published generation.
// A failed write leaves the previous recovery grant untouched. Archives are
// never automatically removed; an interrupted commit leaves a recoverable file.
async function createConfigurationBackup({ panelDirectory, mainDirectory = null,
  outputDirectory, identity, generationStore, recipients = [], withQuiesced, now = Date.now }) {
  if (!path.isAbsolute(outputDirectory) || typeof withQuiesced !== 'function'
    || Boolean(identity) !== Boolean(generationStore)) throw new TypeError('Coordinated backup dependencies required');
  return withQuiesced(async () => {
    const previous = generationStore ? await generationStore.grant() : null;
    const recovery = identity ? createRecoveryMaterial((previous?.generation ?? 0) + 1) : undefined;
    const files = await snapshotInventory(mainDirectory, recipients);
    const sealed = await captureConfiguration({ panelDirectory, mainDirectory,
      files, withQuiesced: work => work(), recovery, now });
    await validateBackupConfiguration(decodeConfiguration(sealed.archive, sealed.recoveryKey));
    const grant = recovery ? signBackupGrant(recovery, sealed.archive, identity.privateKey) : null;
    await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    await privateDirectory(outputDirectory);
    const directory = path.join(outputDirectory, sealed.id);
    await fs.mkdir(directory, { mode: 0o700 });
    await writeNewFile(path.join(directory, 'configuration.awgbackup'), sealed.archive);
    await writeNewFile(path.join(directory, 'recovery-key.txt'), Buffer.from(`${sealed.recoveryKey}\n`));
    if (grant) await writeNewFile(path.join(directory, 'grant.json'), Buffer.from(JSON.stringify(grant)));
    await syncDirectory(directory);
    await syncDirectory(outputDirectory);
    if (grant) await generationStore.commit(grant, recipients);
    return { id: sealed.id, archive: sealed.archive.toString('base64'), recoveryKey: sealed.recoveryKey,
      generation: grant?.generation ?? null, createdAt: now() };
  });
}
module.exports = { snapshotInventory, createConfigurationBackup };
