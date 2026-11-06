'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { runProcess } = require('./ProcessRunner');
const { runNftBatch } = require('./NftBatchRunner');

const TABLE = 'awg_easy_3_technical';
const fields = ['interfaceName', 'ownerTag', 'source4', 'sourcePort', 'peer4', 'peerPort', 'bridgePort'];
const queues = new Map();
const port = value => Number.isInteger(value) && value > 0 && value <= 65535;
function context(value) {
  if (!value || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')
    || !/^[A-Za-z0-9_.-]{1,15}$/.test(value.interfaceName)
    || !/^awg-easy-3-cell:[a-f0-9-]{36}$/.test(value.ownerTag)
    || net.isIP(value.source4) !== 4 || net.isIP(value.peer4) !== 4
    || ![value.sourcePort, value.peerPort, value.bridgePort].every(port)
    || value.sourcePort === value.bridgePort) throw new TypeError('Invalid owned control redirect');
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
function normalize(value) {
  if (!Array.isArray(value?.nftables)) throw new Error('Invalid technical NAT readback');
  const records = value.nftables.filter(item => !item.metainfo).map(item => {
    const keys = Object.keys(item);
    if (keys.length !== 1 || !['table', 'chain', 'rule'].includes(keys[0])) throw new Error('Foreign technical NAT object');
    const [kind] = keys;
    const { handle: _handle, ...body } = item[kind];
    return { [kind]: body };
  });
  return JSON.stringify(sorted(records));
}
function redirectSnapshot(input) {
  const value = context(input);
  const match = (protocol, field, right) => ({ match: { op: '==', left: { payload: { protocol, field } }, right } });
  return { nftables: [
    { table: { family: 'ip', name: TABLE, comment: value.ownerTag } },
    { chain: { family: 'ip', table: TABLE, name: 'output', type: 'nat', hook: 'output', prio: -100, policy: 'accept' } },
    { rule: { family: 'ip', table: TABLE, chain: 'output', comment: value.ownerTag, expr: [
      match('ip', 'saddr', value.source4), match('ip', 'daddr', value.peer4),
      match('udp', 'sport', value.sourcePort), match('udp', 'dport', value.peerPort),
      { redirect: { port: value.bridgePort } },
    ] } },
  ] };
}

// The caller owns the installation-wide flock. verifyOwned rechecks the exact
// AWG manifest/key/alias/ports before every mutation. Only one original UDP
// tuple is redirected; the configured AWG endpoint and data-link never change.
class CellControlRedirect {
  constructor({ directory, verifyOwned, runner = runProcess, table = TABLE,
    validateContext = context, makeSnapshot = redirectSnapshot }) {
    if (!path.isAbsolute(directory) || typeof verifyOwned !== 'function') throw new TypeError('Private control redirect directory and verifier required');
    if (![TABLE, 'awg_easy_3_restore_control', 'awg_easy_3_restore_data'].includes(table)
      || typeof validateContext !== 'function' || typeof makeSnapshot !== 'function') throw new TypeError('Invalid owned endpoint table');
    Object.assign(this, { directory, verifyOwned, runner, table, validateContext, makeSnapshot });
    this.file = path.join(directory, 'redirect.json');
  }
  async prepare() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32'
      && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Unsafe control redirect directory');
  }
  async read() {
    await this.prepare();
    let stat;
    try { stat = await fs.lstat(this.file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048 || process.platform !== 'win32'
      && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Unsafe control redirect journal');
    const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
    if (state?.version !== 1 || !['prepared', 'active', 'removing'].includes(state.phase)
      || Object.keys(state).sort().join(',') !== 'context,phase,version') throw new Error('Invalid control redirect journal');
    this.validateContext(state.context);
    return state;
  }
  async save(state) {
    await this.read();
    const temporary = path.join(this.directory, `.redirect-${crypto.randomUUID()}.tmp`);
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, this.file);
      await this.syncDirectory();
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async syncDirectory() {
    if (process.platform === 'win32') return;
    const directory = await fs.open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async current() {
    const tables = JSON.parse((await this.runner('nft', ['-j', 'list', 'tables'])).stdout);
    if (!Array.isArray(tables?.nftables)) throw new Error('Technical NAT inventory unavailable');
    const found = tables.nftables.filter(item => ['ip', 'ip6'].includes(item.table?.family) && item.table.name === this.table);
    if (!found.length) return null;
    if (found.length !== 1 || this.table === TABLE && found[0].table.family !== 'ip') throw new Error('Ambiguous owned NAT family');
    return JSON.parse((await this.runner('nft', ['-j', 'list', 'table', found[0].table.family, this.table])).stdout);
  }
  async assertOwner(value, recovering = false) {
    if (await this.verifyOwned(value, { recovering }) !== true) throw new Error('Control AWG ownership is unproven');
  }
  async clearFlow(value) {
    try {
      await this.runner('conntrack', [...(net.isIP(value.peer4) === 6 ? ['-f', 'ipv6'] : []), '-D', '-p', 'udp', '--orig-src', value.source4,
        '--orig-dst', value.peer4, '--sport', String(value.sourcePort), '--dport', String(value.peerPort)],
      { env: { ...process.env, LC_ALL: 'C' }, timeoutMs: 5000, maxOutputBytes: 4096 });
    } catch (error) {
      if (error.code !== 1 || !/0 flow entries have been deleted/.test(error.stderr || '')) {
        throw new Error('Owned control connection tracking could not be refreshed');
      }
    }
  }
  exclusive(work) {
    const result = (queues.get(this.file) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(this.file, result);
    const done = () => { if (queues.get(this.file) === result) queues.delete(this.file); };
    result.then(done, done);
    return result;
  }
  async removeInner() {
    const saved = await this.read();
    const current = await this.current();
    if (!saved) { if (current !== null) throw new Error('Unowned technical NAT table'); return; }
    await this.assertOwner(saved.context, true);
    await this.runner('conntrack', ['--version'], { timeoutMs: 5000, maxOutputBytes: 1024 });
    if (current && normalize(current) !== normalize(this.makeSnapshot(saved.context))) throw new Error('Technical NAT table was changed externally');
    await this.save({ ...saved, phase: 'removing' });
    if (current) await this.runner('nft', ['delete', 'table', this.makeSnapshot(saved.context).nftables[0].table.family, this.table]);
    await this.clearFlow(saved.context);
    await fs.unlink(this.file);
    await this.syncDirectory();
  }
  recover() { return this.exclusive(() => this.removeInner()); }
  apply(input) {
    const value = this.validateContext(input);
    return this.exclusive(async () => {
      await this.prepare();
      await this.removeInner();
      await this.assertOwner(value);
      await this.runner('conntrack', ['--version'], { timeoutMs: 5000, maxOutputBytes: 1024 });
      await this.save({ version: 1, phase: 'prepared', context: value });
      const snapshot = this.makeSnapshot(value);
      await runNftBatch(this.runner, JSON.stringify({ nftables: snapshot.nftables.map(item => ({ add: item })) }), this.directory);
      if (normalize(await this.current()) !== normalize(snapshot)) throw new Error('Technical NAT readback mismatch');
      await this.clearFlow(value);
      await this.save({ version: 1, phase: 'active', context: value });
      return { active: true };
    });
  }
}

module.exports = { CellControlRedirect, redirectSnapshot, normalizeTechnicalNat: normalize };
