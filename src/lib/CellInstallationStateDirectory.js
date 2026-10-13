'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// The first Cell installation must reserve a persistent private directory
// before creating its identity, connection journal or installation lock.
// Never repair an existing directory: it may belong to another service.
async function prepareCellInstallationStateDirectory(directory) {
  if (process.platform !== 'linux' || typeof directory !== 'string'
    || !path.isAbsolute(directory) || path.normalize(directory) !== directory
    || /^\/run(?:\/|$)/.test(directory) || directory === '/') {
    throw new TypeError('Persistent absolute Linux Cell state directory required');
  }
  const parent = await fs.lstat(path.dirname(directory));
  if (!parent.isDirectory() || parent.uid !== process.getuid()
    || (parent.mode & 0o022)) {
    throw new Error('Cell state parent must be owned and not writable by others');
  }
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
    || (info.mode & 0o777) !== 0o700) {
    throw new Error('Private Cell state directory required; refusing to change existing path');
  }
  return directory;
}

module.exports = { prepareCellInstallationStateDirectory };
