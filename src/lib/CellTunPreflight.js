'use strict';

const fs = require('node:fs/promises');
const { runProcess } = require('./ProcessRunner');

async function ensureTunDevice({ stat = fs.stat, runner = runProcess,
  platform = process.platform, devicePath = '/dev/net/tun' } = {}) {
  if (platform !== 'linux' || devicePath !== '/dev/net/tun'
    || typeof stat !== 'function' || typeof runner !== 'function') {
    throw new TypeError('Linux TUN preflight required');
  }
  let present;
  try { present = await stat(devicePath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('TUN device inspection failed');
  }
  if (present?.isCharacterDevice()) return { ready: true, moduleLoaded: false };
  if (present) throw new Error('Unsafe TUN device path');
  try { await runner('modprobe', ['tun'], { timeoutMs: 10000 }); }
  catch { throw new Error('TUN module could not be loaded'); }
  try { present = await stat(devicePath); }
  catch { throw new Error('TUN device remains unavailable'); }
  if (!present.isCharacterDevice()) throw new Error('TUN device is not a character device');
  return { ready: true, moduleLoaded: true };
}

module.exports = { ensureTunDevice };
