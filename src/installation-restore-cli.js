'use strict';
const { openInstallationRestore } = require('./lib/InstallationRestore');
const { readPrivateFile } = require('./lib/RestoreCli');
async function main() {
  const [command, root, ...args] = process.argv.slice(2);
  if (process.platform !== 'linux' || process.getuid() !== 0
    || !['prepare', 'commit', 'rollback', 'start', 'complete', 'status'].includes(command)
    || args.length !== (command === 'prepare' ? 3 : 0)) throw new Error('Invalid restore invocation');
  const operation = await openInstallationRestore(root);
  const result = command === 'prepare' ? await operation.prepare({
    archive: await readPrivateFile(args[0], 12 * 1024 * 1024),
    recoveryKey: (await readPrivateFile(args[1], 256)).toString('utf8').trim(), image: args[2],
  }) : await operation[command]();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (require.main === module) main().catch(() => {
  console.error('Installation restore failed. Check the private inputs, destination state and saved restore transaction; no rollback is allowed after service startup.');
  process.exitCode = 1;
});
module.exports = { main };
