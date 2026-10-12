'use strict';

const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const { spawn } = require('node:child_process');

async function acquireFlock(fd) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn('flock', ['-n', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd], windowsHide: true });
    child.stderr.resume();
    child.once('error', error => { if (!settled) { settled = true; reject(error); } });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else if (code === 1) reject(new Error('Another cell installation operation is active'));
      else reject(new Error('Could not acquire cell installation lock'));
    });
  });
}

// Linux flock belongs to the shared open file description. The short-lived
// flock child locks fd 3; the parent's FileHandle retains the lock until work
// finishes and the handle closes. No stale PID file or lock cleanup is needed.
async function withCellInstallationLock({ lockPath, work }) {
  if (process.platform !== 'linux'
    || typeof lockPath !== 'string' || !path.isAbsolute(lockPath)
    || /^\/run(?:\/|$)/.test(lockPath) || typeof work !== 'function') {
    throw new TypeError('Linux persistent cell lock path and work required');
  }
  const directory = await fs.lstat(path.dirname(lockPath));
  if (!directory.isDirectory() || directory.uid !== process.getuid()
    || (directory.mode & 0o077)) {
    throw new Error('Private cell installation state directory required');
  }
  const handle = await fs.open(lockPath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid()
      || (info.mode & 0o077)) throw new Error('Unsafe cell installation lock file');
    await acquireFlock(handle.fd);
    return await work();
  } finally { await handle.close(); }
}

module.exports = { withCellInstallationLock };
