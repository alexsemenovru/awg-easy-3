'use strict';
// Opt-in disposable VM test. Uses ONLY the synthetic Cell state exported by
// the isolated namespace lab. Exercises the real root supervisor and Docker;
// never substitute a production state directory or image.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { ControlIdentityStore } = require('../src/lib/ControlIdentityStore');
const { CellMaintenanceHost } = require('../src/lib/CellMaintenanceHost');
const { MainCellMaintenance, sign, verifyHostRequest, verifyReceipt, receiptAckFor } = require('../src/lib/CellMaintenance');
const { BackupJournal } = require('../src/lib/BackupJournal');
const { AwgTechnicalRelay } = require('../src/lib/AwgTechnicalRelay');
const source = path.resolve(__dirname, '..');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 30000,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const absent = id => { try { run('docker', ['inspect', id]); return false; } catch { run('docker', ['info']); return true; } };
async function child(file, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; process.stdout.on('data', bytes => { output = (output + bytes).slice(-2048); });
    process.stderr.on('data', bytes => { output = (output + bytes).slice(-2048); });
    const timer = setTimeout(() => { process.kill('SIGTERM'); reject(new Error('Supervisor test timed out')); }, 120000);
    process.once('error', reject); process.once('exit', code => {
      clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Supervisor exit ${code}: ${output}`));
    });
  });
}
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.AWG_DISPOSABLE_HOST_TEST !== '1') throw new Error('Disposable VM opt-in required');
  await fs.access('/var/tmp/ALLOW_AWG_MAINTENANCE_TEST');
  if (!absent('network-relay')) throw new Error('Existing Cell: refusing host test');
  const hostLinks = JSON.parse(run('ip', ['-j', 'link', 'show']));
  assert.equal(hostLinks.some(row => ['awgcell8', 'awgcellp8', 'awgcellu8', 'awgdata0'].includes(row.ifname)), false);
  const tables = JSON.parse(run('nft', ['-j', 'list', 'tables']));
  assert.equal(tables.nftables.some(row => row.table?.name.startsWith('awg_easy_3')), false);
  const fixture = path.resolve(process.argv[3] ?? '');
  if (!fixture.startsWith('/var/tmp/awg-maintenance-fixture-')
    || (await fs.readFile(path.join(fixture, '.allow-export'), 'utf8')).trim() !== 'synthetic-cell-only') throw new Error('Synthetic lab fixture required');
  const image = run('docker', ['image', 'inspect', '-f', '{{.Id}}', process.argv[2]]);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const directory = await fs.mkdtemp('/var/tmp/awg-maintenance-host-');
  await fs.chmod(directory, 0o700);
  for (const name of ['cell-maintenance.sh']) await fs.copyFile(path.join(source, name), path.join(directory, name));
  await fs.cp(path.join(source, 'lib'), path.join(directory, 'lib'), { recursive: true });
  await fs.cp(path.join(fixture, 'cell-data'), path.join(directory, 'cell-data'), { recursive: true });
  await fs.chmod(path.join(directory, 'cell-data'), 0o700);
  const hostDirectory = path.join(directory, '.cell-maintenance'); await fs.mkdir(hostDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, '.env.cells-cell'), [
    `AWG_IMAGE=${image}`, 'AWG_CELL_WAN_INTERFACE=veth-cell', 'AWG_CELL_USER_PORT=51830',
    'AWG_CELL_ENDPOINT=198.51.100.2', 'AWG_CELL_DHT_PORT=49033',
    'AWG_CELL_BOOTSTRAP_INTERFACE=awgcell8', 'AWG_CELL_CONTROL_INTERFACE=awgcellp8',
    'AWG_CELL_USER_INTERFACE=awgcellu8', 'AWG_CELL_RUNTIME_DIR=/cell-data/user-runtime', '',
  ].join('\n'), { mode: 0o600 });
  const cell = await new ControlIdentityStore(path.join(directory, 'cell-data/identity.json')).load('cell');
  const controller = JSON.parse(await fs.readFile(path.join(fixture, 'main-identity.json'), 'utf8'));
  let command, acknowledgements = 0;
  const relay = await new AwgTechnicalRelay({ identity: controller, kind: 'main', controlPort: null,
    allowedPeer: key => key === cell.publicKey, lookup: async () => null,
    onReceipt: async receipt => {
      verifyReceipt(receipt, command);
      assert.equal(absent(containerId), true, 'Receipt arrived before actual container removal');
      assert.equal((await new CellMaintenanceHost(hostDirectory).read()).phase, 'container-removed');
      assert.equal(run('docker', ['inspect', '-f', '{{.State.Running}}', foreignId]), 'true');
      acknowledgements++; return receiptAckFor(command, controller);
    } }).start(0, '127.0.0.1');
  let containerId, foreignId;
  try {
    containerId = run('docker', ['run', '-d', '--name', 'network-relay', '--network', 'host',
      '--entrypoint', '/bin/sh', image, '-c', 'sleep 300']);
    foreignId = run('docker', ['run', '-d', '--network', 'none', '--entrypoint', '/bin/sh', image, '-c', 'sleep 300']);
    const store = new MainCellMaintenance(path.join(directory, 'synthetic-main.json'), {
      controller, cellKey: cell.publicKey, endpointHost: 'localhost', port: relay.address().port });
    command = await store.remove();
    const anchor = { controllerKey: controller.publicKey, cellKey: cell.publicKey };
    await new BackupJournal(path.join(directory, 'cell-data/maintenance/request.json'),
      value => verifyHostRequest(value, anchor), 8192).write(sign({ version: 1, command }, cell.privateKey, 'network-maintenance-host/v1'));
    run('sh', [path.join(directory, 'cell-maintenance.sh'), '--init']);
    await child('sh', [path.join(directory, 'cell-maintenance.sh')]);
    assert.equal(absent(containerId), true); assert.equal(acknowledgements, 1);
    assert.equal((await new CellMaintenanceHost(hostDirectory).read()).phase, 'complete');
    await child('sh', [path.join(directory, 'cell-maintenance.sh')]);
    assert.equal(acknowledgements, 1);
    assert.equal(run('docker', ['inspect', '-f', '{{.State.Running}}', foreignId]), 'true');
    console.log('PASS real root supervisor: stopped owned container, cleaned resources, removed exact Docker ID, delivered signed receipt, retained foreign container, idempotent retry');
  } finally {
    await relay.close();
    for (const id of [containerId, foreignId].filter(Boolean)) if (!absent(id)) run('docker', ['rm', '-f', id]);
  }
}
main().catch(error => {
  const reason = String(error.message).split('\n')[0].replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]').slice(0, 200);
  console.error(`Disposable maintenance host test failed: ${reason}; synthetic state retained`); process.exitCode = 1;
});
