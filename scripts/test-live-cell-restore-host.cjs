'use strict';
// Opt-in disposable root VM. Two live Docker Cells survive a cold host restore.
// The old Main runs in its own network namespace. Its floating endpoint moves
// to the fresh destination only AFTER the old processes and namespace stop.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { fixture } = require('../src/test/helpers/BackupFixture');
const { StateStore } = require('../src/lib/StateStore');
const { PasswordManager } = require('../src/lib/PasswordManager');
const { requestInvitation, requestBackup } = require('../src/lib/MainCellInvitationSocket');
const { MainCellEntrySnapshot } = require('../src/lib/MainCellEntrySnapshot');
const { CellAwgConnectionStore } = require('../src/lib/CellAwgConnectionStore');
const { ControlIdentityStore } = require('../src/lib/ControlIdentityStore');
const { epochFor } = require('../src/lib/CellControlAuthority');
const source = path.resolve(__dirname, '..');
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 180000,
  stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
const docker = (...args) => run('docker', args);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, count = 90) {
  for (let i = 0; i < count; i++) { try { const value = await check(); if (value) return value; } catch {} await pause(1000); }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.AWG_DISPOSABLE_HOST_TEST !== '1') throw new Error('Disposable root VM opt-in required');
  await fs.access('/var/tmp/ALLOW_AWG_LIVE_RESTORE_TEST');
  const cellNames = ['awglab-c1', 'awglab-c2'];
  const cellNetworks = ['awglab-n1', 'awglab-n2'];
  const deviceNames = ['awglab-device1', 'awglab-device2'];
  const ownedNames = ['awg-easy-3-main-cell', 'awg-easy-3', ...deviceNames, ...cellNames, ...cellNetworks, 'awglab-old'];
  for (const name of ownedNames) {
    let exists = false; try { docker('inspect', name); exists = true; } catch { docker('info'); }
    if (exists) throw new Error('Existing lab or product container: refusing test');
  }
  const tables = JSON.parse(run('nft', ['-j', 'list', 'tables']));
  if (tables.nftables.some(row => row.table?.name.startsWith('awg_easy_3'))) throw new Error('Existing product firewall: refusing test');
  const image = docker('image', 'inspect', '-f', '{{.Id}}', process.argv[2]);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const root = await fs.mkdtemp('/var/tmp/awg-live-restore-'); await fs.chmod(root, 0o700);
  const old = path.join(root, 'old'), destination = path.join(root, 'destination');
  const bridge = 'awglabbr0', endpoint = '172.31.250.10';
  const containers = [], devices = [];
  const stateFromFixture = async () => JSON.parse(Buffer.from((await fixture()).files.find(row => row.area === 'panel').data, 'base64'));
  const compose = (directory, args, mainEnabled = true) => docker('compose', '--project-directory', directory,
    ...(mainEnabled ? ['--env-file', path.join(directory, '.env.cells-main')] : []), '-f', path.join(directory, 'docker-compose.yml'),
    ...(mainEnabled ? ['-f', path.join(directory, 'docker-compose.cells-main.yml'), '--profile', 'cells-main'] : []), ...args);
  const namespace = name => docker('inspect', '-f', '{{.State.Pid}}', name);
  const inside = (name, file, args) => run('nsenter', ['-t', namespace(name), '-n', file, ...args]);
  async function container(name, address, directory, extra = [], entry = ['/bin/sh', '-c', 'sleep 1800']) {
    const id = docker('run', '-d', '--name', name, '--network', 'none', '--privileged', '--no-healthcheck', '--cap-add', 'NET_ADMIN', '--device', '/dev/net/tun',
      ...(directory ? ['-v', `${directory}:/cell-data:Z`] : []), ...extra, '--entrypoint', entry[0], image, ...entry.slice(1));
    containers.push(id);
    const host = `awglabv${containers.length}`, peer = `awglabp${containers.length}`;
    run('ip', ['link', 'add', host, 'type', 'veth', 'peer', 'name', peer]); devices.push(host);
    run('ip', ['link', 'set', host, 'master', bridge]); run('ip', ['link', 'set', host, 'up']);
    run('ip', ['link', 'set', peer, 'netns', namespace(name)]);
    inside(name, 'ip', ['link', 'set', peer, 'name', 'eth0']); inside(name, 'ip', ['link', 'set', 'eth0', 'up']);
    inside(name, 'ip', ['addr', 'add', `${address}/24`, 'dev', 'eth0']);
    inside(name, 'ip', ['route', 'add', 'default', 'via', '172.31.250.1', 'dev', 'eth0']);
    inside(name, 'sysctl', ['-w', 'net.ipv4.ip_forward=1']);
    return id;
  }
  async function assets(directory, oldNamespace) {
    await fs.mkdir(directory, { mode: 0o700 });
    for (const file of ['restore.sh', 'enable-main-node.sh', 'docker-compose.yml', 'docker-compose.cells-main.yml']) {
      let bytes = await fs.readFile(path.join(source, file));
      if (oldNamespace && file.endsWith('.yml')) bytes = Buffer.from(bytes.toString().replaceAll('network_mode: host', 'privileged: true\n    network_mode: "container:awglab-old"'));
      await fs.writeFile(path.join(directory, file), bytes, { mode: file.endsWith('.sh') ? 0o755 : 0o644 });
    }
    await fs.cp(path.join(source, 'lib'), path.join(directory, 'lib'), { recursive: true });
    await fs.writeFile(path.join(directory, '.env'), `AWG_IMAGE=${image}\n`, { mode: 0o600 });
  }
  const preservedSysctls = [];
  let stage = 'initialization'; let success = false;
  try {
    run('ip', ['link', 'add', bridge, 'type', 'bridge']); devices.push(bridge);
    run('ip', ['addr', 'add', '172.31.250.1/24', 'dev', bridge]); run('ip', ['link', 'set', bridge, 'up']);
    await container('awglab-old', endpoint);
    await assets(old, true);
    const initial = await stateFromFixture();
    Object.assign(initial.server, { interfaceName: 'awglabu0', wanInterface: 'eth0', endpointHost: endpoint, listenPort: 55000 });
    const oldStore = new StateStore(path.join(old, 'data/state.json'));
    await oldStore.save(initial);
    const password = await new PasswordManager({ store: oldStore }).resetPassword();
    compose(old, ['up', '-d'], false);
    await until(() => docker('inspect', '-f', '{{.State.Health.Status}}', 'awg-easy-3') === 'healthy', 'old panel');
    await fs.mkdir(path.join(old, 'cell-data'), { mode: 0o700 });
    await fs.mkdir(path.join(old, 'cell-status/uapi'), { recursive: true, mode: 0o700 });
    await fs.chmod(path.join(old, 'cell-status'), 0o700);
    await fs.writeFile(path.join(old, '.env.cells-main'), [ `AWG_IMAGE=${image}`, 'AWG_MAIN_USER_INTERFACE=awglabu0',
      'AWG_MAIN_USER_PORT=55000', 'AWG_MAIN_BOOTSTRAP_INTERFACE=awgmainb0', 'AWG_MAIN_CONTROL_INTERFACE=awgmainc0',
      'AWG_MAIN_BOOTSTRAP_PORT=53081', 'AWG_MAIN_CONTROL_PORT=53084', 'AWG_MAIN_REGISTRATION_PORT=53082',
      'AWG_MAIN_CONTROL_TCP_PORT=53083', 'AWG_MAIN_BOOTSTRAP_ADDRESS=10.90.8.1', 'AWG_MAIN_CONTROL_ADDRESS=10.91.8.1',
      `AWG_MAIN_ENDPOINT=${endpoint}`, 'AWG_MAIN_DHT_PORT=49033', '' ].join('\n'), { mode: 0o600 });
    compose(old, ['up', '-d']);
    await until(() => fs.access(path.join(old, 'cell-status/control.sock')).then(()=>true), 'old Main IPC');
    const socket = path.join(old, 'cell-status/control.sock');
    stage = 'register-two-live-cells';
    for (const [index, name] of cellNames.entries()) {
      const directory = path.join(root, `cell${index + 1}`); await fs.mkdir(directory, { mode: 0o700 });
      const code = await until(() => requestInvitation(socket), `issue invitation for Cell ${index + 1}`, 8);
      await fs.writeFile(path.join(directory, 'invitation'), code, { mode: 0o600 });
      const network = cellNetworks[index], address = `172.31.250.${index + 2}`;
      await container(network, address);
      docker('run', '-d', '--name', name, '--network', `container:${network}`, '--privileged',
        '--no-healthcheck', '--restart', 'on-failure:3', '-v', `${directory}:/cell-data:Z`,
        '-e', 'AWG_PRIVATE_STATE=1', '-e', 'AWG_CELL_STATE_DIR=/cell-data', '-e', 'AWG_CELL_INVITATION_FILE=/cell-data/invitation',
        '-e', 'AWG_CELL_RUNTIME_DIR=/cell-data/runtime', '-e', 'WG_QUICK_USERSPACE_IMPLEMENTATION=net-forward',
        '-e', 'AWG_CELL_BOOTSTRAP_INTERFACE=awgcellb0',
        '-e', 'AWG_CELL_CONTROL_INTERFACE=awgcellc0', '-e', 'AWG_CELL_USER_INTERFACE=awgcellu0',
        '-e', 'AWG_CELL_USER_PORT=51830', '-e', 'AWG_CELL_WAN_INTERFACE=eth0', '-e', `AWG_CELL_ENDPOINT=${address}`,
        '--entrypoint', '/usr/bin/dumb-init', image, '--', 'node', '/app/link-agent.js', 'serve');
      await until(async () => {
        const rows = Object.values(await new MainCellEntrySnapshot(path.join(old, 'cell-status/entries.json')).readDetails());
        return rows.length === index + 1 && rows.every(row => row.descriptor);
      }, `Cell ${index + 1} registration`);
    }
    const details = await new MainCellEntrySnapshot(path.join(old, 'cell-status/entries.json')).readDetails();
    const ids = Object.keys(details);
    console.log('Two running Cells registered over the real bootstrap and control interfaces');
    stage = 'configure-test-profiles';
    const request = (route, method, body, cookie) => JSON.parse(run('nsenter', [
      '-t', namespace('awglab-old'), '-n', process.execPath, '-e', `
        const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
        fetch('http://10.8.0.1:51821/api/v1' + input.route, {
          method: input.method, signal: AbortSignal.timeout(20000),
          headers: { 'Content-Type': 'application/json', ...(input.cookie ? { Cookie: input.cookie } : {}) },
          body: JSON.stringify(input.body),
        }).then(async r => {
          process.stdout.write(JSON.stringify({ status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0], body: await r.text() }));
        }).catch(() => { process.exitCode = 1; });
      `,
    ], { input: JSON.stringify({ route, method, body, cookie }) }));
    const login = request('/session', 'POST', { password });
    assert.equal(login.status, 200, 'Main login failed in restore fixture');
    assert.ok(login.cookie, 'Main did not issue a session');
    for (let index = 0; index < 2; index++) {
      const created = request('/clients', 'POST', { name: `Lab ${index}`, networkGroup: 'home', entryCellId: ids[index] }, login.cookie);
      assert.equal(created.status, 201, 'Main failed to create a Cell entry profile');
      const { id } = JSON.parse(created.body).client;
      const updated = request(`/clients/${id}`, 'PATCH', { exitNodeId: ids[index] }, login.cookie);
      assert.equal(updated.status, 200, 'Main failed to set the Cell exit');
    }
    await until(async () => {
      const rows = Object.values(await new MainCellEntrySnapshot(path.join(old, 'cell-status/entries.json')).readDetails());
      return rows.length === 2 && rows.every(row => row.routeApplied && Object.keys(row.confirmed).length === 1);
    }, 'two applied profiles');
    const state = await oldStore.load();
    const users = ids.map(id => state.clients.find(client => client.entryCellId === id));
    for (const [index, name] of deviceNames.entries()) {
      const directory = path.join(root, `device${index + 1}`);
      await fs.mkdir(directory, { mode: 0o700 });
      const exported = request(`/clients/${users[index].id}/export?format=native-config`, 'GET', undefined, login.cookie);
      assert.equal(exported.status, 200, 'Main failed to export the applied Cell profile');
      await fs.writeFile(path.join(directory, 'phone.conf'), exported.body, { mode: 0o600 });
      await container(name, `172.31.250.${101 + index}`, directory);
      // The production image has no desktop resolver manager. The probes
      // use literal addresses, keeping the downloaded profile intact.
      docker('exec', name, 'sh', '-ec', [
        'printf "#!/bin/sh\\ncat >/dev/null\\n" > /tmp/resolvconf',
        'chmod 700 /tmp/resolvconf',
        'PATH=/tmp:$PATH awg-quick up /cell-data/phone.conf',
      ].join('; '));
    }
    const panel = name => docker('exec', name, 'node', '-e', `const q=require('http').get('http://10.8.0.1:51821',r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:1))});q.setTimeout(2000,()=>q.destroy());q.on('error',()=>process.exit(1))`) === '';
    for (const name of deviceNames) await until(() => panel(name), `Home panel before restore from ${name}`);
    const runningCells = new Map(cellNames.map(name => [name, namespace(name)]));
    const cellConnections = cellNames.map((_, index) => {
      const directory = path.join(root, `cell${index + 1}`);
      return new CellAwgConnectionStore(path.join(directory, 'connection.json'),
        new ControlIdentityStore(path.join(directory, 'identity.json')));
    });
    const oldEpochs = await Promise.all(cellConnections.map(store => epochFor(store)));
    console.log('Both original client profiles reached the panel before backup');
    stage = 'backup-and-confirm-generation';
    const backup = await requestBackup(socket);
    await fs.writeFile(path.join(root, 'backup.awgbackup'), Buffer.from(backup.archive, 'base64'), { mode: 0o600 });
    await fs.writeFile(path.join(root, 'backup.key'), backup.recoveryKey, { mode: 0o600 });
    await until(async () => {
      const rows = JSON.parse(await fs.readFile(path.join(old, 'cell-status/cells.json'), 'utf8')).cells
        .filter(row => row.status === 'consumed');
      return rows.length === 2 && rows.every(row => row.backup.confirmed && row.backup.generation === backup.generation);
    }, 'backup generation acknowledged');
    console.log('Both Cells acknowledged the archive generation');
    stage = 'destroy-old-main-namespace';
    compose(old, ['stop']); compose(old, ['rm', '-f']); docker('rm', '-f', 'awglab-old');
    run('ip', ['addr', 'add', `${endpoint}/24`, 'dev', bridge]);
    await assets(destination, false);
    const fresh = await stateFromFixture();
    Object.assign(fresh.server, { interfaceName: 'awglabu0', wanInterface: bridge, endpointHost: endpoint, listenPort: 55000 });
    await new StateStore(path.join(destination, 'data/state.json')).save(fresh);
    compose(destination, ['up', '-d'], false);
    await until(() => docker('inspect', '-f', '{{.State.Health.Status}}', 'awg-easy-3') === 'healthy', 'fresh destination panel');
    for (const role of ['main', 'user']) {
      const file = `/etc/sysctl.d/99-awg-easy-3-${role}.conf`;
      try {
        const text = await fs.readFile(file, 'utf8');
        if (!/^(?:net\.ipv4\.conf\.[A-Za-z0-9_.-]+\.(?:rp_filter|src_valid_mark)\s*=\s*[12]\n)+$/.test(text)) throw new Error('Foreign sysctl configuration');
        const saved = path.join(root, `previous-${role}.conf`); await fs.rename(file, saved); preservedSysctls.push({ file, saved });
      } catch (error) { if (error.code !== 'ENOENT') throw error; else preservedSysctls.push({ file, saved: null }); }
    }
    stage = 'actual-host-restore-with-live-cells';
    const output = run('sh', [path.join(destination, 'restore.sh'), path.join(root, 'backup.awgbackup'), path.join(root, 'backup.key')]);
    assert.match(output, /Restore complete/);
    const restored = await new StateStore(path.join(destination, 'data/state.json')).load();
    assert.ok(restored.server.privateKey === state.server.privateKey, 'Main AWG identity changed');
    for (const user of users) {
      const client = restored.clients.find(row => row.id === user.id);
      assert.ok(client?.privateKey === user.privateKey, 'Restored client identity changed');
      assert.equal(client.entryCellId, user.entryCellId);
      assert.equal(client.exitNodeId, user.exitNodeId);
    }
    assert.equal(restored.server.wanInterface, bridge);
    const newAuthority = await new ControlIdentityStore(path.join(destination, 'cell-data/authority.json')).load('controller');
    assert.ok(oldEpochs.every(epoch => newAuthority.publicKey !== epoch.key), 'Restore reused the old live authority');
    await until(async () => {
      const epochs = await Promise.all(cellConnections.map(store => epochFor(store)));
      return epochs.every(epoch => epoch.key === newAuthority.publicKey && epoch.generation === backup.generation);
    }, 'both live Cells accepted the restored authority', 120);
    for (const name of deviceNames) await until(() => panel(name), `Home panel after restore from ${name}`, 120);
    await until(async () => Object.values(await new MainCellEntrySnapshot(path.join(destination, 'cell-status/entries.json')).readDetails())
      .filter(row => row.routeApplied).length === 2, 'both live Cells recovered', 120);
    for (const [name, pid] of runningCells) assert.equal(namespace(name), pid);
    success = true;
    console.log('PASS actual cold host restore with two live Cells: acknowledged backup generation, old Main stopped, new authority, preserved client keys and Home panel access');
  } catch (error) {
    console.error(`Live restore failed at ${stage}; synthetic private artifacts: ${root}`);
    for (const directory of [old, destination]) {
      try {
        const entries = Object.values(await new MainCellEntrySnapshot(path.join(directory, 'cell-status/entries.json')).readDetails());
        if (entries.length) console.error(`${path.basename(directory)} Cell status:`, JSON.stringify(entries.map(row => ({
          announced: Boolean(row.descriptor), confirmedClients: Object.keys(row.confirmed).length, routeApplied: row.routeApplied,
        }))));
      } catch { /* A snapshot may not exist if startup failed. */ }
    }
    // Emit only fixed startup and recovery diagnostics, with no state or keys.
    for (const name of ['awg-easy-3-main-cell', ...cellNames]) {
      try {
        const messages = docker('logs', '--tail', '12', name).split('\n').filter(line =>
          /^(?:Main Cell reconciliation needs attention|Cell bootstrap command failed; check local diagnostics without sharing the invitation|Cell settings service stopped unexpectedly)$/.test(line));
        if (messages.length) console.error(name, [...new Set(messages)].join('; '));
      } catch { /* A container may never have started. */ }
    }
    for (const line of String(error.stderr ?? '').split('\n')) {
      if (/^(?:Error: (?:restore|restored|cannot|another)|awg-quick: )/.test(line)) {
        console.error(line.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]').slice(0, 180));
      }
    }
    throw new Error(String(error.message).split('\n')[0].replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]').slice(0, 140));
  } finally {
    if (success || process.env.AWG_KEEP_FAILED_LAB !== '1') {
    for (const name of ownedNames) {
      try { docker('stop', '-t', '10', name); } catch {} try { docker('rm', name); } catch {}
    }
    for (const item of preservedSysctls) { await fs.unlink(item.file).catch(()=>{}); if (item.saved) await fs.rename(item.saved, item.file); }
    for (const name of devices.reverse()) { try { run('ip', ['link', 'delete', name]); } catch {} }
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
