'use strict';
// Disposable Main/Cell AWG registration test. Run only inside an outer
// unshare --mount --net --pid --fork --kill-child with tmpfs /tmp and /run/netns.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { AwgKeyManager } = require('../src/lib/AwgKeyManager');
const { generateOfficialProfile, renderInterfaceFields } = require('../src/lib/Awg3Config');

assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1');
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), fs.readlinkSync('/proc/1/ns/net'));
const netnsMount = fs.statfsSync('/run/netns');
assert.equal(netnsMount.type, 0x01021994); // tmpfs; no persistent host netns entries
const field = path.join(__dirname, 'cell-awg-direct-field.cjs');
const permanentField = path.join(__dirname, 'cell-awg-permanent-field.cjs');
const cellCli = path.join(__dirname, '..', 'src', 'cell-cli.js');
const root = '/tmp/awg-cell-dual-netns';
const mainDir = path.join(root, 'main');
const cellDir = path.join(root, 'cell');
const deviceDir = path.join(root, 'device');
fs.mkdirSync(mainDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(cellDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(deviceDir, { recursive: true, mode: 0o700 });
const endpoint = '198.51.100.1';
const env = directory => ({ ...process.env, CELL_FIELD_STATE: directory,
  CELL_FIELD_CONTROLLER_PUBLIC: endpoint,
  CELL_FIELD_ROLE: directory === mainDir ? 'controller' : 'cell',
  CELL_FIELD_INTERFACE: directory === mainDir ? 'awgmain8' : 'awgcell8',
  CELL_FIELD_PERMANENT_INTERFACE: directory === mainDir ? 'awgmainp8' : 'awgcellp8',
  ...(directory === cellDir ? { CELL_FIELD_PRODUCT_CELL: '1',
    AWG_CELL_STATE_DIR: cellDir, AWG_CELL_BOOTSTRAP_INTERFACE: 'awgcell8',
    AWG_CELL_CONTROL_INTERFACE: 'awgcellp8', AWG_CELL_USER_INTERFACE: 'awgcellu8',
    AWG_CELL_USER_PORT: '51830' } : {}) });
const ip = args => execFileSync('ip', args, { encoding: 'utf8', timeout: 30000,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const role = (namespace, directory, action, script = field) => JSON.parse(execFileSync('ip',
  ['netns', 'exec', namespace, process.execPath, script, action],
  { env: env(directory), encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'] }));
const runCellCli = (action, input = '') => JSON.parse(execFileSync('ip',
  ['netns', 'exec', 'awgcell', process.execPath, cellCli, action],
  { env: env(cellDir), input, encoding: 'utf8', timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'] }));
let stage = 'namespaces';

function listen(script = field, action = 'controller-listen', expected = 'listening') {
  const child = spawn('ip', ['netns', 'exec', 'awgmain', process.execPath,
    script, action], { env: env(mainDir), stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('listener not ready')), 15000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('listener exited')); });
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      try { assert.deepEqual(JSON.parse(output.trim()), { [expected]: true, transport: 'AWG' });
        resolve(child); }
      catch { reject(new Error('invalid listener status')); }
    });
  });
  return { child, ready };
}

async function main() {
  ip(['netns', 'add', 'awgmain']);
  ip(['netns', 'add', 'awgcell']);
  ip(['netns', 'add', 'awgdevice']);
  ip(['link', 'add', 'veth-main', 'type', 'veth', 'peer', 'name', 'veth-cell']);
  ip(['link', 'set', 'veth-main', 'netns', 'awgmain']);
  ip(['link', 'set', 'veth-cell', 'netns', 'awgcell']);
  ip(['-n', 'awgmain', 'address', 'add', `${endpoint}/30`, 'dev', 'veth-main']);
  ip(['-n', 'awgcell', 'address', 'add', '198.51.100.2/30', 'dev', 'veth-cell']);
  ip(['link', 'add', 'veth-access', 'type', 'veth', 'peer', 'name', 'veth-device']);
  ip(['link', 'set', 'veth-access', 'netns', 'awgcell']);
  ip(['link', 'set', 'veth-device', 'netns', 'awgdevice']);
  ip(['-n', 'awgcell', 'address', 'add', '198.51.100.5/30', 'dev', 'veth-access']);
  ip(['-n', 'awgdevice', 'address', 'add', '198.51.100.6/30', 'dev', 'veth-device']);
  for (const [ns, iface] of [['awgmain', 'veth-main'], ['awgcell', 'veth-cell']]) {
    ip(['-n', ns, 'link', 'set', iface, 'up']);
    ip(['-n', ns, 'link', 'set', 'lo', 'up']);
  }
  ip(['-n', 'awgcell', 'link', 'set', 'veth-access', 'up']);
  ip(['-n', 'awgdevice', 'link', 'set', 'veth-device', 'up']);
  ip(['-n', 'awgdevice', 'link', 'set', 'lo', 'up']);
  ip(['netns', 'exec', 'awgcell', 'sysctl', '-qw', 'net.ipv4.ip_forward=1']);
  stage = 'foreign-resources';
  ip(['-n', 'awgcell', 'link', 'add', 'awgforeign2', 'type', 'dummy']);
  ip(['-n', 'awgcell', 'link', 'set', 'awgforeign2', 'up']);
  ip(['netns', 'exec', 'awgcell', 'nft', 'add', 'table', 'inet', 'foreign_keep']);
  const userKeys = await new AwgKeyManager().generateKeyPair();
  const deviceKeys = await new AwgKeyManager().generateKeyPair();
  const userProfile = generateOfficialProfile();
  fs.writeFileSync(path.join(cellDir, 'cell-server.json'), JSON.stringify({
    interfaceName: 'awgcellu8', wanInterface: 'veth-cell',
    privateKey: userKeys.privateKey, listenPort: 51830,
    address4: '10.88.8.1', ipv4Subnet: '10.88.8.0/24',
    profile: userProfile,
  }), { flag: 'wx', mode: 0o600 });
  stage = 'controller-init';
  assert.equal(role('awgmain', mainDir, 'controller-init').ready, true);
  stage = 'controller-issue';
  assert.equal(role('awgmain', mainDir, 'controller-issue').issued, true);
  fs.copyFileSync(path.join(mainDir, 'invitation'), path.join(cellDir, 'invitation'));
  fs.chmodSync(path.join(cellDir, 'invitation'), 0o600);
  stage = 'cell-foreign-interface-collision';
  ip(['-n', 'awgcell', 'link', 'add', 'awgcell8', 'type', 'dummy']);
  assert.throws(() => runCellCli('begin', fs.readFileSync(path.join(cellDir, 'invitation'), 'utf8')));
  assert.equal(fs.existsSync(path.join(cellDir, 'connection.json')), false);
  ip(['-n', 'awgcell', 'link', 'show', 'awgcell8']);
  ip(['-n', 'awgcell', 'link', 'delete', 'awgcell8']);
  stage = 'cell-begin';
  assert.equal(runCellCli('begin', fs.readFileSync(path.join(cellDir, 'invitation'), 'utf8')).status,
    'bootstrap-ready');
  stage = 'cell-provision';
  assert.equal(runCellCli('resume').status, 'bootstrap-ready');
  stage = 'registration';
  const listener = listen();
  try {
    await listener.ready;
    assert.equal(runCellCli('register').status, 'registered');
    const controller = role('awgmain', mainDir, 'controller-status');
    assert.equal(controller.verified, true);
    assert.equal(controller.invitations[0].status, 'consumed');
    stage = 'product-controller-join-initial';
    assert.equal(role('awgmain', mainDir, 'product-controller-join', permanentField).status,
      'waiting-for-permanent-path');
    const control = listen(permanentField, 'control-listen', 'controlListening');
    try {
      await control.ready;
      stage = 'product-permanent-join';
      let ready = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const result = runCellCli('join');
        if (result.status === 'ready') { ready = true; break; }
        assert.equal(result.status, 'waiting-for-permanent-path');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.equal(ready, true);
      stage = 'temporary-retirement';
      assert.equal(role('awgmain', mainDir, 'product-controller-join', permanentField).status, 'ready');
      const peer = role('awgcell', cellDir, 'product-status', permanentField);
      assert.equal(peer.permanentReady, true);
      assert.equal(peer.temporaryRetired, true);
      const controllerPath = role('awgmain', mainDir, 'product-controller-status', permanentField);
      assert.equal(controllerPath.permanentReady, true);
      assert.equal(controllerPath.bootstrapPhase, 'closed');
      stage = 'control-sync';
      stage = 'control-publish';
      assert.equal(role('awgmain', mainDir, 'publish', permanentField).revision, 1);
      stage = 'control-sync-request';
      const result = role('awgcell', cellDir, 'product-sync', permanentField);
      assert.equal(result.status, 'applied');
      ip(['-n', 'awgcell', 'link', 'show', 'awgcellu8']);
      ip(['netns', 'exec', 'awgcell', 'nft', 'list', 'table', 'inet', 'awg_easy_3']);
      stage = 'control-sync-ack';
      const synced = role('awgmain', mainDir, 'status', permanentField);
      assert.equal(synced.applied, synced.desired);
    } finally { control.child.kill('SIGTERM'); }
    stage = 'control-outage';
    await new Promise((resolve, reject) => {
      if (control.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => reject(new Error('control listener did not exit')), 5000);
      control.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    assert.throws(() => role('awgcell', cellDir, 'product-sync', permanentField));
    assert.equal(role('awgmain', mainDir, 'product-controller-status', permanentField).permanentReady, true);
    assert.equal(runCellCli('join').status, 'waiting-for-permanent-path');
    stage = 'control-recovery';
    const recovered = listen(permanentField, 'control-listen', 'controlListening');
    try {
      await recovered.ready;
      fs.writeFileSync(path.join(mainDir, 'desired-payload.json'), JSON.stringify({ schema: 1,
        clients: [{ id: 'synthetic-device', publicKey: deviceKeys.publicKey,
          address4: '10.88.8.2', networkGroup: 'guest', ipv4Enabled: true,
          ipv6Enabled: false, geoPolicy: { mode: 'off', countries: [] } }] }),
      { flag: 'wx', mode: 0o600 });
      assert.equal(role('awgmain', mainDir, 'publish', permanentField).revision, 2);
      assert.equal(role('awgcell', cellDir, 'product-sync', permanentField).status, 'applied');
      const synced = role('awgmain', mainDir, 'status', permanentField);
      assert.equal(synced.applied, synced.desired);
      stage = 'synthetic-user-traffic';
      fs.writeFileSync(path.join(deviceDir, 'awgdevice8.conf'),
        `[Interface]\nPrivateKey = ${deviceKeys.privateKey}\nAddress = 10.88.8.2/32\n`
        + `${renderInterfaceFields(userProfile)}\n[Peer]\nPublicKey = ${userKeys.publicKey}\n`
        + 'AllowedIPs = 198.51.100.1/32\nEndpoint = 198.51.100.5:51830\nPersistentKeepalive = 5\n',
      { flag: 'wx', mode: 0o600 });
      ip(['netns', 'exec', 'awgdevice', 'awg-quick', 'up', path.join(deviceDir, 'awgdevice8.conf')]);
      ip(['netns', 'exec', 'awgdevice', 'ping', '-c', '3', '-W', '2', '198.51.100.1']);
      stage = 'cell-join-idempotency';
      assert.equal(runCellCli('join').status, 'ready');
      stage = 'controller-join-idempotency';
      assert.equal(role('awgmain', mainDir, 'product-controller-join', permanentField).status, 'ready');
    } finally { recovered.child.kill('SIGTERM'); }
    stage = 'foreign-resource-readback';
    ip(['-n', 'awgcell', 'link', 'show', 'awgforeign2']);
    const foreignTable = JSON.parse(ip(['netns', 'exec', 'awgcell', 'nft', '-j', 'list', 'tables']));
    assert.ok(foreignTable.nftables.some(item => item.table?.name === 'foreign_keep'));
    console.log('PASS isolated Main/Cell lifecycle, control recovery, foreign-resource isolation and synthetic user traffic');
  } finally { listener.child.kill('SIGTERM'); }
}
main().catch(error => {
  const detail = String(error.stderr || error.message || '');
  const classification = ['timeout', 'refused', 'network', 'receiver', 'connection',
    'tunnel', 'route', 'identity', 'handshake', 'revision', 'registered', 'required']
    .filter(word => detail.toLowerCase().includes(word)).join(',') || 'unclassified';
  const safeDetail = detail.split(/\r?\n/)[0].replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]').slice(0, 160);
  console.error(`Dual-netns Cell lab failed at ${stage}; status ${error.status ?? 'unknown'}; class ${classification}; ${safeDetail}; invitation and keys withheld`);
  process.exitCode = 1;
});
