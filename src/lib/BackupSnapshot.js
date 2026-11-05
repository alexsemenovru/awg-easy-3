'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { validateState } = require('./StateStore');
const { sealBackup, openBackup } = require('./BackupEnvelope');
const { validEndpointHost } = require('./CellAwgEndpointHost');
const { validateRecoveryMaterial } = require('./BackupRecovery');

const LIMIT = 8 * 1024 * 1024;
const FILE_LIMIT = 4 * 1024 * 1024;
const MAX_FILES = 2048;
const KIND = 'awg-easy-3/configuration-snapshot';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('Invalid configuration backup snapshot'); };
const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).sort().join(',') === keys.sort().join(',');
function allowed(area, name) {
  if (area === 'panel') return name === 'state.json';
  return area === 'main' && (['identity.json', 'config.json', 'bootstrap.json',
    'permanent/plan.json', 'permanent/revision.json'].includes(name)
    || /^(?:cell-settings|cell-descriptors|cell-data-keys|cell-data-offers|cell-routing)\/[a-f0-9]{64}\.json(?:\.ack)?$/.test(name)
    || /^data-links\/[a-f0-9]{64}\/plan\.json$/.test(name));
}
function validateSnapshot(value) {
  if (!exact(value, ['version', 'kind', 'createdAt', 'files', ...(value?.recovery === undefined ? [] : ['recovery'])]) || value.version !== 1 || value.kind !== KIND
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Array.isArray(value.files)
    || !value.files.length || value.files.length > MAX_FILES) fail();
  if (value.recovery !== undefined) validateRecoveryMaterial(value.recovery);
  const names = new Set();
  let total = 0;
  for (const file of value.files) {
    if (!exact(file, ['area', 'name', 'sha256', 'data']) || !allowed(file.area, file.name)
      || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.data !== 'string'
      || file.data.length > 4 * FILE_LIMIT / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) fail();
    const bytes = Buffer.from(file.data, 'base64');
    if (!bytes.length || bytes.length > FILE_LIMIT || bytes.toString('base64') !== file.data
      || hash(bytes) !== file.sha256) fail();
    total += file.data.length;
    if (total > LIMIT || names.has(`${file.area}/${file.name}`)) fail();
    names.add(`${file.area}/${file.name}`);
    // Reject malformed JSON before staging; never unpack executable archives,
    // arbitrary paths, shell hooks, logs, DHT contacts or cached traffic data.
    try {
      const parsed = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
      if (file.area === 'panel') validateState(parsed);
    } catch { fail(); }
  }
  if (!names.has('panel/state.json')) fail();
  const main = [...names].some(name => name.startsWith('main/'));
  if (main && ['identity.json', 'config.json', 'bootstrap.json'].some(name => !names.has(`main/${name}`))) fail();
  if (Buffer.byteLength(JSON.stringify(value)) > LIMIT) fail();
  return value;
}
async function privateDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32'
    && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Private backup directory required');
}
async function readPrivate(root, name) {
  await privateDirectory(root);
  const segments = name.split('/');
  for (let index = 1; index < segments.length; index++) await privateDirectory(path.join(root, ...segments.slice(0, index)));
  const file = await fs.open(path.join(root, ...segments), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(FILE_LIMIT)
      || process.platform !== 'win32' && (stat.uid !== BigInt(process.getuid()) || stat.mode & 0o077n)) {
      throw new Error('Unsafe backup source file');
    }
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || bytes.length !== Number(stat.size)) {
      throw new Error('Backup source changed while reading');
    }
    return bytes;
  } finally { await file.close(); }
}

// The runtime coordinator MUST stop/lock all writers for the entire callback.
// A second pass detects accidental changes; it does not replace quiescence or
// Cell generation/fencing, and is not exposed as a finished product backup.
async function captureConfiguration({ panelDirectory, mainDirectory = null, files,
  withQuiesced, now = Date.now, recovery }) {
  if (!path.isAbsolute(panelDirectory) || mainDirectory !== null && !path.isAbsolute(mainDirectory)
    || typeof withQuiesced !== 'function' || !Array.isArray(files) || files.length > MAX_FILES) {
    throw new TypeError('Explicit snapshot roots, file inventory and quiesced coordinator required');
  }
  const inventory = files.map(file => {
    if (!exact(file, ['area', 'name']) || !allowed(file.area, file.name)
      || file.area === 'main' && mainDirectory === null) fail();
    return { ...file };
  }).sort((a, b) => `${a.area}/${a.name}`.localeCompare(`${b.area}/${b.name}`, 'en'));
  return withQuiesced(async () => {
    const roots = { panel: panelDirectory, main: mainDirectory };
    const captured = [];
    for (const item of inventory) {
      const bytes = await readPrivate(roots[item.area], item.name);
      captured.push({ ...item, sha256: hash(bytes), data: bytes.toString('base64') });
      if (Buffer.byteLength(JSON.stringify(captured)) > LIMIT) fail();
    }
    const snapshot = validateSnapshot({ version: 1, kind: KIND, createdAt: now(), files: captured,
      ...(recovery === undefined ? {} : { recovery: validateRecoveryMaterial(recovery) }) });
    for (const item of captured) {
      if (hash(await readPrivate(roots[item.area], item.name)) !== item.sha256) throw new Error('Backup source changed before snapshot commit');
    }
    return sealBackup(Buffer.from(JSON.stringify(snapshot)));
  });
}

function decodeConfiguration(archive, recoveryKey) {
  try {
    const bytes = openBackup(archive, recoveryKey);
    const raw = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    const value = JSON.parse(raw);
    if (JSON.stringify(value) !== raw) fail(); // duplicate properties/trailing bytes
    return validateSnapshot(value);
  } catch { fail(); }
}

function prepareRestoredPanelState(snapshot, target) {
  validateSnapshot(snapshot);
  if (!exact(target, ['interfaceName', 'wanInterface', 'endpointHost', 'listenPort', 'panelPort'])
    || ![target.interfaceName, target.wanInterface].every(name => /^[A-Za-z0-9_.-]{1,15}$/.test(name))
    || target.interfaceName === target.wanInterface || !validEndpointHost(target.endpointHost)
    || ![target.listenPort, target.panelPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) {
    throw new Error('Explicit validated target host settings required');
  }
  const source = snapshot.files.find(file => file.area === 'panel' && file.name === 'state.json');
  const original = validateState(JSON.parse(Buffer.from(source.data, 'base64').toString('utf8')));
  const { pendingTotp: _pending, ...auth } = original.auth;
  // Old browser cookies must not survive a restore. Keep password/active TOTP,
  // user keys, ULA prefix and policies; use the NEW machine's explicit bindings.
  return validateState({ ...original, server: { ...original.server, ...target },
    auth: { ...auth, sessionSecret: crypto.randomBytes(32).toString('hex') } });
}

// Inspection/staging only. Never overwrite an installation, execute archived
// commands, restore kernel ownership journals or take control of a Cell here.
// Product restore still needs semantic cross-validation and fencing before
// any staged file can be promoted into a live installation.
async function stageConfiguration(snapshot, directory) {
  snapshot = structuredClone(snapshot);
  validateSnapshot(snapshot);
  if (!path.isAbsolute(directory)) throw new TypeError('Absolute empty backup staging path required');
  await privateDirectory(path.dirname(directory));
  await fs.mkdir(directory, { mode: 0o700 }); // EEXIST is intentional, even if empty
  const directories = new Set([directory]);
  for (const item of snapshot.files) {
    const target = path.join(directory, item.area, ...item.name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    for (let current = path.dirname(target); current !== directory; current = path.dirname(current)) directories.add(current);
    const file = await fs.open(target, 'wx', 0o600);
    try { await file.writeFile(Buffer.from(item.data, 'base64')); await file.sync(); } finally { await file.close(); }
  }
  if (process.platform !== 'win32') {
    // Persist the new directory entries before publishing the completion marker.
    for (const current of [...directories].sort((a, b) => b.length - a.length)) {
      const parent = await fs.open(current, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  const manifest = await fs.open(path.join(directory, 'staging-complete.json'), 'wx', 0o600);
  try {
    await manifest.writeFile(JSON.stringify({ version: 1, createdAt: snapshot.createdAt,
      files: snapshot.files.map(({ area, name, sha256 }) => ({ area, name, sha256 })) }));
    await manifest.sync();
  } finally { await manifest.close(); }
  if (process.platform !== 'win32') {
    for (const current of [directory, path.dirname(directory)]) {
      const parent = await fs.open(current, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  return { staged: true, files: snapshot.files.length };
}
module.exports = { captureConfiguration, decodeConfiguration, stageConfiguration,
  prepareRestoredPanelState, validateSnapshot, allowedSnapshotFile: allowed };
