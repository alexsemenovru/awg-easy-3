'use strict';
// Opt-in disposable VM only. Runs the actual host restore command and Compose;
// refuses an existing AWG-Easy installation. Never use a production VPS.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { fixture } = require('../src/test/helpers/BackupFixture');
const { createRecoveryMaterial } = require('../src/lib/BackupRecovery');
const { sealBackup } = require('../src/lib/BackupEnvelope');
const { StateStore } = require('../src/lib/StateStore');
const source = path.resolve(__dirname, '..');
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 180000,
  stdio: ['ignore', 'pipe', 'pipe'], ...options });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.AWG_DISPOSABLE_HOST_TEST !== '1') throw new Error('Disposable VM opt-in required');
  await fs.access('/var/tmp/ALLOW_AWG_RESTORE_TEST');
  for (const name of ['awg-easy-3', 'awg-easy-3-main-cell']) {
    let exists = false;
    try { run('docker', ['inspect', name]); exists = true; } catch {}
    if (exists) throw new Error('Existing installation: refusing host test');
  }
  const image = run('docker', ['image', 'inspect', '-f', '{{.Id}}', process.argv[2]]).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Pinned lab image required');
  const directory = await fs.mkdtemp('/var/tmp/awg-host-restore-');
  const snapshot = await fixture(); snapshot.recovery = createRecoveryMaterial(6);
  const original = JSON.parse(Buffer.from(snapshot.files.find(item => item.area === 'panel').data, 'base64'));
  const targetSnapshot = await fixture();
  const target = JSON.parse(Buffer.from(targetSnapshot.files.find(item => item.area === 'panel').data, 'base64'));
  Object.assign(target.server, { interfaceName: 'awgrtest0', wanInterface: run('sh', ['-c', "ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i==\"dev\") {print $(i+1);exit}}'"]).trim(),
    endpointHost: '198.51.100.77', listenPort: 55000 });
  await new StateStore(path.join(directory, 'data/state.json')).save(target);
  const sealed = sealBackup(Buffer.from(JSON.stringify(snapshot)));
  await fs.writeFile(path.join(directory, 'source.awgbackup'), sealed.archive, { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'source.key'), sealed.recoveryKey, { mode: 0o600 });
  for (const file of ['restore.sh', 'enable-main-node.sh', 'docker-compose.yml', 'docker-compose.cells-main.yml']) {
    await fs.copyFile(path.join(source, file), path.join(directory, file));
    if (file.endsWith('.sh')) await fs.chmod(path.join(directory, file), 0o755);
  }
  await fs.cp(path.join(source, 'lib'), path.join(directory, 'lib'), { recursive: true });
  await fs.writeFile(path.join(directory, '.env'), `AWG_IMAGE=${image}\nAWG_HOST=198.51.100.77\nAWG_PORT=55000\nAWG_PANEL_PORT=51821\n`, { mode: 0o600 });
  const compose = args => run('docker', ['compose', '--project-directory', directory, '-f', path.join(directory, 'docker-compose.yml'), ...args]);
  try {
    compose(['up', '-d']);
    let healthy = false;
    for (let index = 0; index < 80; index++) {
      if (run('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'awg-easy-3']).trim() === 'healthy') { healthy = true; break; }
      await sleep(1000);
    }
    assert.equal(healthy, true, 'Fresh destination did not become healthy');
    const output = run('sh', [path.join(directory, 'restore.sh'), path.join(directory, 'source.awgbackup'), path.join(directory, 'source.key')]);
    assert.match(output, /Restore complete/);
    const restored = await new StateStore(path.join(directory, 'data/state.json')).load();
    assert.equal(restored.server.privateKey === original.server.privateKey, true, 'Server identity was not restored');
    assert.equal(restored.clients[0].privateKey === original.clients[0].privateKey, true, 'Client identity was not restored');
    assert.equal(restored.server.interfaceName, 'awgrtest0');
    assert.equal(restored.server.endpointHost, '198.51.100.77');
    const transaction = JSON.parse(await fs.readFile(path.join(directory, '.restore/transaction.json')));
    assert.equal(transaction.phase, 'complete');
    const previous = await new StateStore(path.join(directory, '.restore', transaction.id, 'previous/data/state.json')).load();
    assert.equal(previous.server.privateKey === target.server.privateKey, true, 'Previous destination was not retained');
    const enrollment = JSON.parse(await fs.readFile(path.join(directory, 'cell-data/bootstrap.json')));
    assert.equal(enrollment.invitations.filter(row => row.status === 'consumed').length, 2);
    assert.equal(run('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'awg-easy-3']).trim(), 'healthy');
    assert.equal(run('docker', ['inspect', '-f', '{{.State.Running}}', 'awg-easy-3-main-cell']).trim(), 'true');
    console.log('PASS actual restore command: encrypted archive, retained previous data, preserved identities, new bindings, healthy panel and Main with two enrolled Cells');
    console.log(`Private test artifacts: ${directory}`);
  } finally {
    for (const name of ['awg-easy-3-main-cell', 'awg-easy-3']) {
      try { run('docker', ['stop', '-t', '15', name]); } catch {}
      try { run('docker', ['rm', name]); } catch {}
    }
    // The dedicated VM retains private journals and exact owned nft resources
    // for inspection/cleanup. No wildcard firewall deletion is performed here.
  }
}
main().catch(() => { console.error('Host restore test failed; inspect private test artifacts (no keys printed).'); process.exitCode = 1; });
