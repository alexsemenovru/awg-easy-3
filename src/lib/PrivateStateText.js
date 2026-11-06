'use strict';

// Obfuscation against casual file inspection, NOT a secret kept from root or
// from someone who examines this decoder. No additional decryption key to lose.
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const release = require('../package.json').version;
const MAX = 32 * 1024 * 1024;
const tokenFor = version => crypto.createHash('sha256').update(`network-private-format/v1/${version}`).digest('hex').slice(0, 16);
const keyFor = token => crypto.createHash('sha256').update(`network-private-packing/v1/${token}`).digest();
function enabled(file) {
  if (process.env.AWG_PRIVATE_STATE !== '1' || !process.env.AWG_CELL_STATE_DIR || typeof file !== 'string') return false;
  const root = path.resolve(process.env.AWG_CELL_STATE_DIR), relative = path.relative(root, path.resolve(file));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
function encodeStateText(text, file, version = release) {
  if (!enabled(file)) return text;
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX) throw new Error('Private state text too large');
  const token = tokenFor(version), nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(token), nonce);
  cipher.setAAD(Buffer.from(token));
  const compressed = zlib.brotliCompressSync(Buffer.from(text), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } });
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return `~${token}.${nonce.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}
function decodeStateText(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 48 * 1024 * 1024) throw new Error('Invalid private state text');
  if (!text.startsWith('~')) return text; // Explicit legacy JSON/text compatibility.
  try {
    const match = text.match(/^~([a-f0-9]{16})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/);
    if (!match) throw new Error();
    const [, token, nonce, body, tag] = match;
    for (const value of [nonce, body, tag]) if (Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(token), Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(token)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const compressed = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
    const bytes = zlib.brotliDecompressSync(compressed, { maxOutputLength: MAX });
    return new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } catch { throw new Error('Private state cannot be decoded'); }
}
const parseStateText = text => JSON.parse(decodeStateText(text));
function transientDirectory(file) { return enabled(file) ? '/run/network-ops' : path.dirname(file); }
async function withPlainConfiguration(file, text, work) {
  const parent = transientDirectory(file);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(parent, '.task-'));
  const temporary = path.join(directory, path.basename(file));
  try {
    await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    return await work(temporary);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
async function openCommandFile(directory, text) {
  const file = path.join(directory, `.task-${crypto.randomUUID()}`);
  const handle = await fs.open(file, 'wx+', 0o600);
  try {
    await fs.unlink(file); // No plaintext filename, including after a process crash.
    await handle.writeFile(text);
    // /proc can belong to an outer PID namespace in isolated test runners.
    const visiblePid = await fs.readlink('/proc/self');
    if (!/^\d+$/.test(visiblePid)) throw new Error('Private command descriptor is unavailable');
    return { file: `/proc/${visiblePid}/fd/${handle.fd}`, close: () => handle.close() };
  } catch (error) { await handle.close(); await fs.unlink(file).catch(() => {}); throw error; }
}
async function withUnlinkedFile(directory, text, work) {
  const input = await openCommandFile(directory, text);
  try { return await work(input.file); } finally { await input.close(); }
}
async function prepareCellStateFiles() {
  const root = process.env.AWG_CELL_STATE_DIR;
  if (!root || !enabled(path.join(root, 'identity.json'))) return;
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const { withCellInstallationLock } = require('./CellInstallationLock');
  await withCellInstallationLock({ lockPath: path.join(root, 'install.lock'), work: async () => {
    let count = 0;
    const visit = async directory => {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Private Cell directory required');
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (++count > 4096 || entry.isSymbolicLink()) throw new Error('Unsafe Cell state inventory');
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'geoip') await visit(file); continue; }
        if (!entry.isFile() || !/\.(json|conf|nft)$/.test(entry.name)) continue;
        const info = await fs.lstat(file);
        if (info.nlink !== 1 || info.uid !== process.getuid() || info.mode & 0o077 || info.size > MAX) throw new Error('Unsafe Cell state file');
        const text = await fs.readFile(file, 'utf8');
        const plain = decodeStateText(text);
        if (text.startsWith(`~${tokenFor(release)}.`)) continue;
        const temporary = path.join(directory, `.state-${crypto.randomUUID()}.tmp`);
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try { await handle.writeFile(encodeStateText(plain, file)); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporary, file);
          const parent = await fs.open(directory, 'r');
          try { await parent.sync(); } finally { await parent.close(); }
        } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      }
    };
    await visit(root);
  } });
}
module.exports = { enabled, encodeStateText, decodeStateText, parseStateText, transientDirectory,
  withPlainConfiguration, withUnlinkedFile, openCommandFile, prepareCellStateFiles };
