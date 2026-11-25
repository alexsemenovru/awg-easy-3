'use strict';
// Disposable root VM: real Docker/Compose replacement and interrupted retry.
// Only the unpublished registry/signature boundary is a deterministic fixture;
// production verification is unchanged and covered by its separate tests.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { ControlIdentityStore } = require('../src/lib/ControlIdentityStore');
const { MainCellMaintenance, sign, verifyHostRequest } = require('../src/lib/CellMaintenance');
const { CellMaintenanceHost } = require('../src/lib/CellMaintenanceHost');
const { CellControlService } = require('../src/lib/CellControlService');
const { verifyControlReply } = require('../src/lib/CellControlProtocol');
const { BackupJournal } = require('../src/lib/BackupJournal');
const root = path.resolve(__dirname, '..');
const run = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const shell = (file, ...args) => new Promise((resolve, reject) => {
  const child = spawn('sh', [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', b => { output = (output + b).slice(-2048); }); child.stderr.on('data', b => { output = (output + b).slice(-2048); });
  const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Root update test timeout')); }, 120000);
  child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); }); child.once('error', reject);
});
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.AWG_DISPOSABLE_HOST_TEST !== '1') throw new Error('Disposable root VM opt-in required');
  await fs.access('/var/tmp/ALLOW_AWG_MAINTENANCE_TEST');
  let existing = false; try { run('inspect', 'network-relay'); existing = true; } catch { run('info'); }
  if (existing) throw new Error('Existing Cell: refusing update test');
  const fixture = path.resolve(process.argv[3]);
  if (!fixture.startsWith('/var/tmp/awg-maintenance-fixture-') || (await fs.readFile(path.join(fixture, '.allow-export'), 'utf8')).trim() !== 'synthetic-cell-only') throw new Error('Synthetic fixture required');
  const image = run('image', 'inspect', '-f', '{{.Id}}', process.argv[2]); assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const manifest = require('../src/package.json');
  const version = manifest.version.split('.').map(Number);
  version[2]++;
  const next = version.join('.');
  const directory = await fs.mkdtemp('/var/tmp/awg-update-host-'); await fs.chmod(directory, 0o700);
  await fs.copyFile(path.join(root, 'cell-maintenance.sh'), path.join(directory, 'cell-maintenance.sh'));
  await fs.cp(path.join(root, 'lib'), path.join(directory, 'lib'), { recursive: true });
  await fs.cp(path.join(fixture, 'cell-data'), path.join(directory, 'cell-data'), { recursive: true });
  await fs.chmod(path.join(directory, 'cell-data'), 0o700);
  const host = path.join(directory, '.cell-maintenance'); await fs.mkdir(host, { mode: 0o700 });
  const composeFile = path.join(directory, 'docker-compose.cells-cell.yml');
  await fs.writeFile(composeFile, 'services:\n  cell:\n    image: ${AWG_IMAGE}\n    container_name: network-relay\n    network_mode: none\n    restart: unless-stopped\n    volumes:\n      - ./cell-data:/cell-data\n    entrypoint: ["/bin/sh", "-c", "sleep 600"]\n');
  const environment = path.join(directory, '.env.cells-cell');
  await fs.writeFile(environment, `AWG_IMAGE=${image}\nAWG_CELL_BOOTSTRAP_INTERFACE=awgcell8\nAWG_CELL_CONTROL_INTERFACE=awgcellp8\nAWG_CELL_USER_INTERFACE=awgcellu8\nAWG_CELL_USER_PORT=51830\n`, { mode: 0o600 });
  const compose = args => run('compose', '--project-directory', directory, '--env-file', environment, '-f', composeFile, ...args);
  const nextManifest = path.join(directory, 'package.json');
  await fs.writeFile(nextManifest, JSON.stringify({ ...manifest, version: next }));
  const tag = `awg-easy-3:synthetic-update-${Date.now()}`;
  const template = run('create', '--network', 'none', image);
  try {
    run('cp', nextManifest, `${template}:/app/package.json`);
    run('commit', template, tag);
  } finally { run('rm', '-v', template); }
  const candidate = run('image', 'inspect', '-f', '{{.Id}}', tag);
  const official = `ghcr.io/alexsemenovru/awg-easy-3:${next}`;
  const digest = `ghcr.io/alexsemenovru/awg-easy-3@sha256:${'a'.repeat(64)}`;
  // Test-only remote boundary adapter. Never copied into the real installation.
  await fs.appendFile(path.join(directory, 'lib/auto-update.sh'), `
awg_easy_latest_stable_version() { printf '%s\\n' '${next}'; }
awg_easy_verify_candidate_image() { [ "$1:$3" = '${next}:${digest}' ]; }
timeout() {
  if [ "$1:$2:$3:$4" = '300:docker:pull:${official}' ]; then return 0; fi
  command timeout "$@"
}
docker() {
  if [ "$1:$2" = image:inspect ]; then
    case "$*" in
      *'{{range .RepoDigests}}'*) printf '%s\\n' '${digest}'; return 0 ;;
      *'{{index .Config.Labels'*) printf '%s\\n' '${'b'.repeat(40)}'; return 0 ;;
      *'${digest}'*) command docker image inspect -f '{{.Id}}' '${candidate}'; return ;;
    esac
  fi
  if [ "$1" = compose ] && [ -f '${directory}/inject-once' ]; then
    case "$*" in
      *'up -d --pull never cell'*)
        command docker rm -f "$AWG_TEST_PREVIOUS" >/dev/null || return 1
        rm '${directory}/inject-once'
        return 1 ;;
    esac
  fi
  command docker "$@"
}
`);
  try {
    compose(['up', '-d']); const previous = run('inspect', '-f', '{{.Id}}', 'network-relay');
    const cell = await new ControlIdentityStore(path.join(directory, 'cell-data/identity.json')).load('cell');
    const controller = JSON.parse(await fs.readFile(path.join(fixture, 'main-identity.json'), 'utf8'));
    const main = new MainCellMaintenance(path.join(directory, 'synthetic-main.json'), { controller, cellKey: cell.publicKey, endpointHost: 'localhost', version: next });
    const mainControl = new CellControlService({
      identityStore: { load: async () => controller },
      enrollmentStore: { read: async () => ({ invitations: [{ status: 'consumed', cellKey: cell.publicKey }] }) },
      maintenanceForCell: () => main,
    });
    const reportVersion = async containerId => {
      const bytes = Buffer.from(run('exec', containerId, 'node', '-e', `
        const { ControlIdentityStore } = require('/app/lib/ControlIdentityStore');
        const { signControl } = require('/app/lib/CellControlProtocol');
        const version = require('/app/package.json').version;
        new ControlIdentityStore('/cell-data/identity.json').load('cell').then(identity => {
          process.stdout.write(JSON.stringify(signControl({
            controllerKey: process.argv[1], action: 'maintenance', payload: { version },
          }, identity.privateKey)));
        }).catch(() => { process.exitCode = 1; });
      `, controller.publicKey));
      const reply = await mainControl.handle(bytes);
      assert.equal(reply.ok, true, 'Main rejected the version report');
      return verifyControlReply(reply, controller.publicKey, JSON.parse(bytes).requestId).maintenance;
    };
    const command = await reportVersion(previous);
    assert.equal(command.targetVersion, next);
    await new BackupJournal(path.join(directory, 'cell-data/maintenance/request.json'),
      value => verifyHostRequest(value, { controllerKey: controller.publicKey, cellKey: cell.publicKey }), 8192)
      .write(sign({ version: 1, command }, cell.privateKey, 'network-maintenance-host/v1'));
    const supervisor = path.join(directory, 'cell-maintenance.sh');
    const initialized = await shell(supervisor, '--init');
    assert.equal(initialized.code, 0, initialized.output);
    assert.equal((await new CellMaintenanceHost(host).anchor.read()).containerId, previous);
    await fs.writeFile(path.join(directory, 'inject-once'), '', { mode: 0o600 });
    process.env.AWG_TEST_PREVIOUS = previous;
    const interrupted = await shell(supervisor);
    assert.notEqual(interrupted.code, 0);
    assert.match(interrupted.output, /replacement startup failed/);
    assert.throws(() => run('inspect', previous));
    assert.throws(() => run('inspect', 'network-relay'));
    assert.equal((await new CellMaintenanceHost(host).read()).replacementImageId, candidate);
    const resumed = await shell(supervisor); assert.equal(resumed.code, 0, resumed.output);
    const replacement = run('inspect', '-f', '{{.Id}}', 'network-relay'); assert.notEqual(replacement, previous);
    assert.equal(run('exec', replacement, 'node', '-p', "require('/app/package.json').version"), next);
    const state = await new CellMaintenanceHost(host).read(); assert.equal(state.phase, 'complete'); assert.equal(state.containerId, replacement);
    assert.equal((await main.status()).matchesMain, false);
    assert.equal(await reportVersion(replacement), null);
    assert.deepEqual(await main.status(), { version: next, action: null, targetVersion: null, completed: false, matchesMain: true });
    assert.equal((await shell(supervisor)).code, 0);
    assert.equal(run('inspect', '-f', '{{.Id}}', 'network-relay'), replacement);
    console.log('PASS real Compose replacement, forward retry and authenticated version confirmation from the new container (local registry fixture)');
  } finally {
    try { compose(['down']); } catch {}
    run('image', 'rm', tag);
  }
}
main().catch(error => {
  console.error([error.message?.split('\n')[0], String(error.stderr ?? '').trim()]
    .filter(Boolean).join('\n').split('\n').slice(-8).join('\n')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]').slice(0, 900));
  process.exitCode = 1;
});
