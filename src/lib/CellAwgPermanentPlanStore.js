'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { specification } = require('./CellAwgLifecycle');
const { manifest } = require('./CellRouteOwnership');
const { normalizeNftSnapshot, dataTable } = require('./CellNftOwnership');

const TABLE = 'awg_easy_3_control';
const LIMIT = 1024 * 1024;

function validatePermanentPlan(value, { policyTable = TABLE } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'policy,routeCommands,spec,version'
    || value.version !== 1) throw new TypeError('Invalid permanent AWG plan');
  const spec = specification(value.spec);
  // Only the fixed control table or one bounded, per-link data table may be
  // persisted here; the caller's store pins which one it owns.
  if (policyTable !== TABLE && !dataTable(policyTable)) {
    throw new TypeError('Invalid permanent AWG policy table');
  }
  const policy = normalizeNftSnapshot(value.policy, policyTable);
  const routes = manifest(value.routeCommands);
  const routeCommands = routes.map(item => item.command);
  if (routes.some(item => item.record.kind !== 'route' || item.record.type !== 'unicast'
    || item.record.table !== 254 || item.record.dev !== spec.owner.interfaceName)) {
    throw new TypeError('Permanent AWG route targets another interface');
  }
  const normalized = { version: 1, spec, policy, routeCommands };
  if (Buffer.byteLength(JSON.stringify(normalized)) > LIMIT) {
    throw new TypeError('Permanent AWG plan too large');
  }
  return normalized;
}

class CellAwgPermanentPlanStore {
  constructor(filePath, { policyTable = TABLE } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('Permanent plan path required');
    this.filePath = path.resolve(filePath);
    this.policyTable = policyTable;
  }

  async directory() {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || (process.platform !== 'win32'
      && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new Error('Private permanent AWG plan directory required');
    }
    return directory;
  }

  async read() {
    let raw;
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT
        || (process.platform !== 'win32'
          && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
        throw new Error('Unsafe permanent AWG plan');
      }
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try { return validatePermanentPlan(JSON.parse(raw), { policyTable: this.policyTable }); }
    catch { throw new Error('Unreadable permanent AWG plan; automatic replacement disabled'); }
  }

  async reserve(plan) {
    if (!plan || (Object.hasOwn(plan, 'version') && plan.version !== 1)) {
      throw new TypeError('Unsupported permanent AWG plan version');
    }
    const normalized = validatePermanentPlan({ ...plan, version: 1 },
      { policyTable: this.policyTable });
    const directory = await this.directory();
    const temporary = path.join(directory, `.permanent-plan-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(normalized)); await handle.sync(); }
      finally { await handle.close(); }
      // Hard-link creation is atomic and fails if the destination exists.
      // Never rename over a prior plan, including an unreadable one.
      await fs.link(temporary, this.filePath);
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      return normalized;
    } finally {
      await fs.unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

module.exports = { CellAwgPermanentPlanStore, validatePermanentPlan };
