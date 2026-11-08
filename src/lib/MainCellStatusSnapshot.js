'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_BYTES = 512 * 1024;
const STATUS = new Set(['pending', 'consumed', 'revoked']);
const PHASE = new Set(['preparing', 'ready', 'closing', 'closed']);
const revision = value => value === null || Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.sort().join(',');

function validateSnapshot(value) {
  if (!exact(value, ['version', 'updatedAt', 'cells']) || value.version !== 1
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
    || !Array.isArray(value.cells) || value.cells.length > 1024) {
    throw new Error('Invalid Main Cell status snapshot');
  }
  const ids = new Set();
  const cells = value.cells.map(cell => {
    const registered = cell?.status === 'consumed' && cell?.phase === 'closed';
    if (!exact(cell, registered
      ? ['id', 'status', 'phase', 'createdAt', 'settings', ...(cell.control === undefined ? [] : ['control']),
        ...(cell.backup === undefined ? [] : ['backup']), ...(cell.maintenance === undefined ? [] : ['maintenance'])]
      : ['id', 'status', 'phase', 'createdAt'])
      || !/^[a-f0-9]{32}$/.test(cell.id) || ids.has(cell.id)
      || !STATUS.has(cell.status) || !PHASE.has(cell.phase)
      || !Number.isSafeInteger(cell.createdAt) || cell.createdAt < 0
      || cell.createdAt > value.updatedAt) {
      throw new Error('Invalid Main Cell status snapshot');
    }
    ids.add(cell.id);
    if (cell.maintenance !== undefined) {
      const value = cell.maintenance, { stable } = require('./CellMaintenance');
      if (!registered || !exact(value, ['version', 'action', 'targetVersion', 'completed', 'matchesMain'])
        || value.version !== null && !stable(value.version) || ![null, 'update', 'remove'].includes(value.action)
        || value.targetVersion !== null && !stable(value.targetVersion)
        || typeof value.completed !== 'boolean' || typeof value.matchesMain !== 'boolean') throw new Error('Invalid Cell maintenance status');
    }
    if (cell.backup !== undefined && (!registered || !exact(cell.backup, ['generation', 'confirmed'])
      || !revision(cell.backup.generation) || typeof cell.backup.confirmed !== 'boolean'
      || cell.backup.generation === null && cell.backup.confirmed)) throw new Error('Invalid Cell backup status');
    if (cell.control !== undefined && (!registered || !exact(cell.control, ['path', 'receivedAt'])
      || ![null, 'direct', 'technical'].includes(cell.control.path)
      || !Number.isSafeInteger(cell.control.receivedAt) || cell.control.receivedAt < cell.createdAt
      || cell.control.receivedAt > value.updatedAt)) throw new Error('Invalid Cell control observation');
    if (registered && (!exact(cell.settings,
      ['desiredRevision', 'confirmedRevision', 'awaitingAck'])
      || !revision(cell.settings.desiredRevision)
      || !revision(cell.settings.confirmedRevision)
      || typeof cell.settings.awaitingAck !== 'boolean'
      || cell.settings.confirmedRevision !== null
        && (cell.settings.desiredRevision === null
          || cell.settings.confirmedRevision > cell.settings.desiredRevision))) {
      throw new Error('Invalid Main Cell status snapshot');
    }
    return registered ? { id: cell.id, status: cell.status, phase: cell.phase,
      createdAt: cell.createdAt, settings: { ...cell.settings },
      ...(cell.control === undefined ? {} : { control: { ...cell.control } }),
      ...(cell.backup === undefined ? {} : { backup: { ...cell.backup } }),
      ...(cell.maintenance === undefined ? {} : { maintenance: { ...cell.maintenance } }) }
      : { id: cell.id, status: cell.status, phase: cell.phase,
        createdAt: cell.createdAt };
  });
  return { version: 1, updatedAt: value.updatedAt, cells };
}

class MainCellStatusSnapshot {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new TypeError('Absolute Main Cell status path required');
    }
    this.filePath = filePath;
  }

  async write(cells, now = Date.now()) {
    const snapshot = validateSnapshot({ version: 1, updatedAt: now, cells });
    const data = JSON.stringify(snapshot);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Main Cell status snapshot too large');
    const directory = path.dirname(this.filePath);
    const dir = await fs.lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()
      || process.platform !== 'win32'
        && (dir.uid !== process.getuid() || (dir.mode & 0o077))) {
      throw new Error('Private Main Cell status directory required');
    }
    const temporary = path.join(directory, `.main-cell-status-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(data); await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return snapshot;
  }

  async read({ now = Date.now(), maxAgeMs = 120000 } = {}) {
    if (!Number.isSafeInteger(now) || now < 0
      || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000) {
      throw new TypeError('Invalid Main Cell status age');
    }
    let raw;
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES
        || process.platform !== 'win32'
          && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
        throw new Error('Unsafe Main Cell status snapshot');
      }
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'unavailable', updatedAt: null, cells: [] };
      throw error;
    }
    const snapshot = validateSnapshot(JSON.parse(raw));
    if (snapshot.updatedAt > now + 30000 || now - snapshot.updatedAt > maxAgeMs) {
      return { state: 'stale', updatedAt: snapshot.updatedAt, cells: [] };
    }
    return { state: 'ready', updatedAt: snapshot.updatedAt, cells: snapshot.cells };
  }
}

module.exports = { MainCellStatusSnapshot, validateSnapshot };
