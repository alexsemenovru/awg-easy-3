'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { validateState } = require('./StateStore');
const { prepareConfigurationRestore, inspectPreparedRestore } = require('./ConfigurationRestore');
async function readPrivateFile(filePath, limit) {
  if (!path.isAbsolute(filePath)) throw new Error('Absolute private restore input path required');
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(limit) || process.platform !== 'win32'
      && (stat.uid !== BigInt(process.getuid()) || stat.mode & 0o077n)) throw new Error('Unsafe restore input file');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!bytes.length || bytes.length > limit || BigInt(bytes.length) !== stat.size
      || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs) throw new Error('Invalid restore input size');
    return bytes;
  } finally { await handle.close(); }
}
async function runRestoreCli({ args, output }) {
  if (!Array.isArray(args) || !output || typeof output.write !== 'function'
    || !['prepare', 'inspect'].includes(args[0]) || args.length !== (args[0] === 'prepare' ? 5 : 2)) {
    throw new Error('Usage: restore-cli.js prepare ARCHIVE KEY_FILE NEW_HOST_STATE OUTPUT | inspect OUTPUT');
  }
  let result;
  if (args[0] === 'inspect') result = await inspectPreparedRestore(args[1]);
  else {
    const archive = await readPrivateFile(args[1], 12 * 1024 * 1024);
    const recoveryKey = (await readPrivateFile(args[2], 256)).toString('utf8').trim();
    const current = validateState(JSON.parse((await readPrivateFile(args[3], 4 * 1024 * 1024)).toString('utf8')));
    const { interfaceName, wanInterface, endpointHost, listenPort, panelPort } = current.server;
    await prepareConfigurationRestore({ archive, recoveryKey, directory: args[4],
      target: { interfaceName, wanInterface, endpointHost, listenPort, panelPort } });
    result = await inspectPreparedRestore(args[4]);
  }
  // No archive key, profiles or private identities ever enter stdout/stderr.
  output.write(`${JSON.stringify({ prepared: result.prepared, activated: false,
    main: result.main, cells: result.cells, clients: result.clients, generation: result.generation })}\n`);
  return result;
}
module.exports = { runRestoreCli };
