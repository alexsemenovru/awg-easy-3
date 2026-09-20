'use strict';
// Internal disposable-VPS harness, NOT an installer or production service.
// Interfaces must already have been created by the test with private ownership
// manifests. This program never adopts/relabels/creates an interface.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runProcess } = require('../src/lib/ProcessRunner');
const { compileCellRouting } = require('../src/lib/CellRoutingPolicy');
const { CellRoutingCoordinator } = require('../src/lib/CellRoutingCoordinator');
const { validateAwgOwnership, inspectAwgOwnership } = require('../src/lib/CellAwgOwnership');
async function privateFile(file, maxBytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > maxBytes) throw new Error('Private field file required');
  return fs.readFile(file, 'utf8');
}
async function main() {
  if (process.platform !== 'linux' || process.env.AWG_CELL_FIELD_TEST !== '1') throw new Error('Explicit Linux field-test environment required');
  const argv = process.argv.slice(2), locked = argv[0] === '--locked-child';
  if (locked) argv.shift();
  const [action, directory, bundleFile] = argv;
  if (argv.length !== 3 || !['apply', 'recover', 'status'].includes(action) || !path.isAbsolute(directory || '')
    || path.dirname(path.resolve(directory)) === path.resolve(directory) || !path.isAbsolute(bundleFile || '')) throw new Error('Invalid field invocation');
  process.umask(0o077);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const dirStat = await fs.lstat(directory);
  if (!dirStat.isDirectory() || dirStat.uid !== process.getuid() || (dirStat.mode & 0o077)) throw new Error('Private field directory required');
  if (!locked) {
    // flock is a native per-command supervisor, not a background service. Keep
    // its lock file inode: deleting it would let another process bypass a lock.
    const lockFile = path.join(directory, 'runtime.lock');
    const handle = await fs.open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); await handle.close();
    await privateFile(lockFile, 4096);
    const child = spawnSync('flock', ['-n', lockFile, process.execPath, __filename, '--locked-child', ...argv], { stdio: 'inherit', env: process.env });
    if (child.error || child.signal) throw new Error('Field flock execution failed');
    process.exitCode = child.status ?? 1; return;
  }
  // --locked-child is a trusted local implementation detail, not a security
  // boundary against root. All documented invocations go through flock above.
  const bundle = JSON.parse(await privateFile(bundleFile, 32 * 1024 * 1024));
  if (!bundle || bundle.version !== 1 || Object.keys(bundle).sort().join(',') !== 'context,geoDatabase,nodeId,owners,topology,version'
    || !Array.isArray(bundle.owners)) throw new Error('Invalid field bundle');
  const built = compileCellRouting(bundle);
  const interfaces = [bundle.context.clientInterface, ...Object.values(bundle.context.links || {}).map(link => link.interfaceName)].sort();
  const owners = new Map();
  for (const value of bundle.owners) {
    const owner = validateAwgOwnership(value);
    if (owners.has(owner.interfaceName) || !interfaces.includes(owner.interfaceName)) throw new Error('Invalid field interface ownership');
    owners.set(owner.interfaceName, owner);
  }
  if (owners.size !== interfaces.length) throw new Error('Incomplete field ownership');
  const coordinator = new CellRoutingCoordinator({ directory, verifyInterfaces: async names => {
    for (const name of names) {
      if (!owners.has(name)) return false;
      const links = JSON.parse((await runProcess('ip', ['-d', '-j', 'link', 'show', 'dev', name])).stdout);
      const actualConfig = (await runProcess('awg', ['showconf', name], { maxOutputBytes: 4 * 1024 * 1024 })).stdout;
      const result = inspectAwgOwnership({ manifest: owners.get(name), links, actualConfig });
      if (!result.verified || !result.up) return false;
    }
    return true;
  } });
  let result;
  if (action === 'apply') result = await coordinator.apply({ version: 1, interfaces, commands: built.commands, nftSnapshot: built.nftSnapshot });
  else if (action === 'recover') result = await coordinator.recover();
  else {
    const saved = await coordinator.load();
    result = { committed: saved.committed !== null, pending: saved.pending !== null,
      verified: saved.committed !== null && !saved.pending && await coordinator.verify(saved.committed),
      guardPresent: await coordinator.guard.current() !== null };
  }
  console.log(JSON.stringify(result)); // booleans only; never print the private bundle
}
main().catch(() => {
  // Subprocess errors can contain sensitive showconf/config material. Do not
  // dump Error objects, stderr, bundle fields or keys in the field CLI.
  console.error('Field routing action refused or failed; private state retained.');
  process.exitCode = 1;
});
