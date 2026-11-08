'use strict';
// Disposable Main/Cell AWG registration test. Run only inside an outer
// unshare --mount --net --pid --fork --kill-child with tmpfs /tmp and /run/netns.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { AwgKeyManager } = require('../src/lib/AwgKeyManager');
const { generateOfficialProfile, renderInterfaceFields } = require('../src/lib/Awg3Config');
const { decodeAwgBootstrapInvitation } = require('../src/lib/CellAwgBootstrapInvitation');
const { StateStore } = require('../src/lib/StateStore');
const { MainCellStatusSnapshot } = require('../src/lib/MainCellStatusSnapshot');

assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1');
const outerNetns = process.env.AWG_OUTER_NETNS || fs.readlinkSync('/proc/1/ns/net');
assert.match(outerNetns, /^net:\[\d+\]$/);
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), outerNetns);
const netnsMount = fs.statfsSync('/run/netns');
assert.equal(netnsMount.type, 0x01021994); // tmpfs; no persistent host netns entries
const field = path.join(__dirname, 'cell-awg-direct-field.cjs');
const permanentField = path.join(__dirname, 'cell-awg-permanent-field.cjs');
const cellCli = path.join(__dirname, '..', 'src', 'cell-cli.js');
const mainCli = path.join(__dirname, '..', 'src', 'main-cell-cli.js');
const root = '/tmp/awg-cell-dual-netns';
const mainDir = path.join(root, 'main');
const cellDir = path.join(root, 'cell');
const cell2Dir = path.join(root, 'cell2');
const deviceDir = path.join(root, 'device');
const statusDir = path.join(root, 'public-status');
fs.mkdirSync(mainDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(cellDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(cell2Dir, { recursive: true, mode: 0o700 });
fs.mkdirSync(deviceDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(statusDir, { recursive: true, mode: 0o700 });
const endpoint = '198.51.100.1';
const env = directory => ({ ...process.env, CELL_FIELD_STATE: directory,
  CELL_FIELD_CONTROLLER_PUBLIC: endpoint,
  CELL_FIELD_ROLE: directory === mainDir ? 'controller' : 'cell',
  CELL_FIELD_INTERFACE: directory === mainDir ? 'awgmain8'
    : directory === cell2Dir ? 'awgcell9' : 'awgcell8',
  CELL_FIELD_PERMANENT_INTERFACE: directory === mainDir ? 'awgmainp8'
    : directory === cell2Dir ? 'awgcellp9' : 'awgcellp8',
  ...(directory === mainDir ? { CELL_FIELD_PRODUCT_MAIN: '1',
    AWG_MAIN_CELL_STATE_DIR: mainDir, AWG_MAIN_BOOTSTRAP_INTERFACE: 'awgmain8',
    AWG_MAIN_CONTROL_INTERFACE: 'awgmainp8', AWG_MAIN_BOOTSTRAP_PORT: '53081',
    AWG_MAIN_CONTROL_PORT: '53084', AWG_MAIN_REGISTRATION_PORT: '53082',
    AWG_MAIN_CONTROL_TCP_PORT: '53083', AWG_MAIN_BOOTSTRAP_ADDRESS: '10.90.8.1',
    AWG_MAIN_CONTROL_ADDRESS: '10.91.8.1', AWG_MAIN_ENDPOINT: endpoint,
    AWG_MAIN_USER_INTERFACE: 'awg0', AWG_MAIN_USER_PORT: '51820',
    AWG_MAIN_USER_STATE_FILE: path.join(root, 'user-state.json'),
    AWG_MAIN_STATUS_FILE: path.join(statusDir, 'cells.json') } : {}),
  ...(directory !== mainDir ? { CELL_FIELD_PRODUCT_CELL: '1',
    AWG_CELL_STATE_DIR: directory,
    AWG_CELL_BOOTSTRAP_INTERFACE: directory === cell2Dir ? 'awgcell9' : 'awgcell8',
    AWG_CELL_CONTROL_INTERFACE: directory === cell2Dir ? 'awgcellp9' : 'awgcellp8',
    AWG_CELL_USER_INTERFACE: directory === cell2Dir ? 'awgcellu9' : 'awgcellu8',
    AWG_CELL_USER_PORT: '51830', AWG_CELL_RUNTIME_DIR: path.join(directory, 'user-runtime') } : {}) });
const ip = args => execFileSync('ip', args, { encoding: 'utf8', timeout: 30000,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const role = (namespace, directory, action, script = field) => JSON.parse(execFileSync('ip',
  ['netns', 'exec', namespace, process.execPath, script, action],
  { env: env(directory), encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'] }));
const runCellCli = (action, input = '', namespace = 'awgcell', directory = cellDir) => JSON.parse(execFileSync('ip',
  ['netns', 'exec', namespace, process.execPath, cellCli, action],
  { env: env(directory), input, encoding: 'utf8', timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'] }));
const runMainCli = (...args) => execFileSync('ip',
  ['netns', 'exec', 'awgmain', process.execPath, mainCli, ...args],
  { env: env(mainDir), encoding: 'utf8', timeout: 30000,
    input: args[0] === 'publish'
      ? (fs.existsSync(path.join(mainDir, 'desired-payload.json'))
        ? fs.readFileSync(path.join(mainDir, 'desired-payload.json'), 'utf8')
        : JSON.stringify({ schema: 1, clients: [] })) : undefined,
    stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let stage = 'namespaces';
const services = new Set();
function track(child) {
  services.add(child);
  child.once('exit', () => services.delete(child));
  return child;
}

function listen(script = mainCli, action = 'listen', expected = 'listening') {
  const child = track(spawn('ip', ['netns', 'exec', 'awgmain', process.execPath,
    script, action], { env: env(mainDir), stdio: ['ignore', 'pipe', 'pipe'] }));
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

function startMainService() {
  const child = track(spawn('ip', ['netns', 'exec', 'awgmain', process.execPath,
    mainCli, 'serve'], { env: env(mainDir), stdio: ['ignore', 'pipe', 'pipe'] }));
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Main service not ready')), 15000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Main service exited')); });
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      try {
        assert.deepEqual(JSON.parse(output.trim()),
          { status: 'serving', permanentConfigured: true });
        resolve(child);
      } catch { reject(new Error('Invalid Main service status')); }
    });
  });
  return { child, ready };
}

async function stopped(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    // An in-flight authenticated poll has a bounded 10 s socket timeout.
    const timer = setTimeout(() => reject(new Error('Listener did not exit')), 30000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function main() {
  const mainUserKeys = await new AwgKeyManager().generateKeyPair();
  // A real Main sidecar reads the existing panel state read-only. The lab
  // persists a synthetic panel state so the same reservation check runs here.
  await new StateStore(path.join(root, 'user-state.json')).save({
    version: 1, auth: { passwordHash: 'synthetic-hash', sessionSecret: 'synthetic-session' },
    server: { interfaceName: 'awg0', wanInterface: 'veth-main',
      privateKey: mainUserKeys.privateKey, publicKey: mainUserKeys.publicKey,
      address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24', listenPort: 51820,
      panelPort: 51821, endpointHost: endpoint, profile: generateOfficialProfile() },
    clients: [{ id: 'synthetic-home', name: 'Synthetic Home', enabled: true,
      networkGroup: 'home', address4: '10.8.0.2',
      privateKey: Buffer.alloc(32, 47).toString('base64'), publicKey: Buffer.alloc(32, 48).toString('base64') }],
  });
  ip(['netns', 'add', 'awgmain']);
  ip(['netns', 'add', 'awgcell']);
  ip(['netns', 'add', 'awgcell2']);
  ip(['netns', 'add', 'awgdevice']);
  ip(['link', 'add', 'veth-main', 'type', 'veth', 'peer', 'name', 'veth-cell']);
  ip(['link', 'set', 'veth-main', 'netns', 'awgmain']);
  ip(['link', 'set', 'veth-cell', 'netns', 'awgcell']);
  ip(['-n', 'awgmain', 'address', 'add', `${endpoint}/30`, 'dev', 'veth-main']);
  ip(['-n', 'awgcell', 'address', 'add', '198.51.100.2/30', 'dev', 'veth-cell']);
  ip(['link', 'add', 'veth-main2', 'type', 'veth', 'peer', 'name', 'veth-cell2']);
  ip(['link', 'set', 'veth-main2', 'netns', 'awgmain']);
  ip(['link', 'set', 'veth-cell2', 'netns', 'awgcell2']);
  ip(['-n', 'awgmain', 'address', 'add', '198.51.100.9/30', 'dev', 'veth-main2']);
  ip(['-n', 'awgcell2', 'address', 'add', '198.51.100.10/30', 'dev', 'veth-cell2']);
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
  ip(['-n', 'awgmain', 'link', 'set', 'veth-main2', 'up']);
  ip(['-n', 'awgmain', 'route', 'replace', '198.51.100.8/30', 'dev', 'veth-main2',
    'src', endpoint]);
  ip(['-n', 'awgcell2', 'link', 'set', 'veth-cell2', 'up']);
  ip(['-n', 'awgcell2', 'link', 'set', 'lo', 'up']);
  ip(['-n', 'awgcell2', 'route', 'add', `${endpoint}/32`, 'via', '198.51.100.9']);
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
  assert.equal(JSON.parse(runMainCli('init')).status, 'bootstrap-ready');
  stage = 'controller-issue';
  const invitation = runMainCli('issue', '10.90.8.2', '10.91.8.2');
  const invitationId = decodeAwgBootstrapInvitation(invitation).id;
  fs.writeFileSync(path.join(mainDir, 'invitation'), invitation, { flag: 'wx', mode: 0o600 });
  fs.copyFileSync(path.join(mainDir, 'invitation'), path.join(cellDir, 'invitation'));
  fs.chmodSync(path.join(cellDir, 'invitation'), 0o600);
  stage = 'main-reboot-recovery';
  ip(['-n', 'awgmain', 'link', 'delete', 'awgmain8']);
  ip(['netns', 'exec', 'awgmain', 'nft', 'delete', 'table', 'inet', 'awg_easy_3_bootstrap']);
  assert.equal(JSON.parse(runMainCli('resume')).status, 'bootstrap-ready');
  assert.equal(role('awgmain', mainDir, 'controller-status').verified, true);
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
      stage = 'cell-user-config';
      assert.equal(runCellCli('configure-user', JSON.stringify({ version: 1,
        server: JSON.parse(fs.readFileSync(path.join(cellDir, 'cell-server.json'), 'utf8')) })).status,
      'user-configured');
    const controller = role('awgmain', mainDir, 'controller-status');
    assert.equal(controller.verified, true);
    assert.equal(controller.invitations[0].status, 'consumed');
    assert.throws(() => runMainCli('publish', invitationId));
    assert.throws(() => runMainCli('settings-status', invitationId));
    stage = 'product-controller-join-initial';
    assert.equal(JSON.parse(runMainCli('join', invitationId)).status,
      'waiting-for-permanent-path');
    const control = listen(mainCli, 'control-listen', 'controlListening');
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
      assert.equal(JSON.parse(runMainCli('join', invitationId)).status, 'ready');
      const peer = role('awgcell', cellDir, 'product-status', permanentField);
      assert.equal(peer.permanentReady, true);
      assert.equal(peer.temporaryRetired, true);
      const controllerPath = role('awgmain', mainDir, 'product-controller-status', permanentField);
      assert.equal(controllerPath.permanentReady, true);
      assert.equal(controllerPath.bootstrapPhase, 'closed');
      stage = 'control-sync';
      stage = 'control-publish';
      assert.equal(JSON.parse(runMainCli('publish', invitationId)).revision, 1);
      stage = 'control-sync-request';
      const result = runCellCli('sync');
      assert.equal(result.status, 'applied');
      assert.deepEqual(runCellCli('status'), { registration: 'registered',
        permanentPlan: true, userConfigured: true,
        receivedRevision: 1, appliedRevision: 1 });
      ip(['-n', 'awgcell', 'link', 'show', 'awgcellu8']);
      ip(['netns', 'exec', 'awgcell', 'nft', 'list', 'table', 'inet', 'awg_easy_3']);
      stage = 'control-sync-ack';
      const synced = JSON.parse(runMainCli('settings-status', invitationId));
      assert.equal(synced.confirmedRevision, synced.desiredRevision);
      const inventory = JSON.parse(runMainCli('cells'));
      assert.equal(inventory.length, 1);
      assert.deepEqual(inventory[0], { id: invitationId, status: 'consumed',
        phase: 'closed', createdAt: inventory[0].createdAt, settings: synced,
        maintenance: { version: require('../src/package.json').version, action: null, targetVersion: null, completed: false, matchesMain: true },
        control: { path: null, receivedAt: inventory[0].control.receivedAt },
        backup: { generation: null, confirmed: false } });
      assert.ok(inventory[0].control.receivedAt >= inventory[0].createdAt);
      assert.equal(JSON.stringify(inventory).includes('cellKey'), false);
    } finally { control.child.kill('SIGTERM'); }
    stage = 'control-outage';
    await new Promise((resolve, reject) => {
      if (control.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => reject(new Error('control listener did not exit')), 5000);
      control.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    assert.throws(() => runCellCli('sync'));
    assert.equal(role('awgmain', mainDir, 'product-controller-status', permanentField).permanentReady, true);
    assert.equal(runCellCli('join').status, 'waiting-for-permanent-path');
    stage = 'control-recovery';
    let secondId;
    const recovered = listen(mainCli, 'control-listen', 'controlListening');
    try {
      await recovered.ready;
      const assigned = JSON.stringify({ schema: 1,
        clients: [{ id: 'synthetic-device', publicKey: deviceKeys.publicKey,
          address4: '10.88.8.2', networkGroup: 'guest', ipv4Enabled: true,
          ipv6Enabled: false, geoPolicy: { mode: 'off', countries: [] } }] });
      fs.writeFileSync(path.join(mainDir, 'desired-payload.json'), assigned,
        { flag: 'wx', mode: 0o600 });
      assert.equal(JSON.parse(runMainCli('publish', invitationId)).revision, 2);
      assert.equal(runCellCli('sync').status, 'applied');
      // A settings-only fixture has no signed routing revision. Product sync
      // must retain the traffic guard; exercise the standalone settings adapter
      // explicitly for the following policy/NAT tests, without weakening it.
      ip(['netns', 'exec', 'awgcell', 'nft', 'list', 'table', 'inet', 'awg_easy_3_cell_guard']);
      assert.equal(role('awgcell', cellDir, 'product-sync', permanentField).status, 'applied');
      const synced = JSON.parse(runMainCli('settings-status', invitationId));
      assert.equal(synced.confirmedRevision, synced.desiredRevision);
      stage = 'synthetic-user-traffic';
      fs.writeFileSync(path.join(deviceDir, 'awgdevice8.conf'),
        `[Interface]\nPrivateKey = ${deviceKeys.privateKey}\nAddress = 10.88.8.2/32\n`
        + `${renderInterfaceFields(userProfile)}\n[Peer]\nPublicKey = ${userKeys.publicKey}\n`
        + 'AllowedIPs = 198.51.100.1/32\nEndpoint = 198.51.100.5:51830\nPersistentKeepalive = 5\n',
      { flag: 'wx', mode: 0o600 });
      ip(['netns', 'exec', 'awgdevice', 'awg-quick', 'up', path.join(deviceDir, 'awgdevice8.conf')]);
      ip(['netns', 'exec', 'awgdevice', 'ping', '-c', '3', '-W', '2', '198.51.100.1']);
      stage = 'synthetic-user-revocation';
      fs.unlinkSync(path.join(mainDir, 'desired-payload.json'));
      assert.equal(JSON.parse(runMainCli('publish', invitationId)).revision, 3);
      assert.equal(role('awgcell', cellDir, 'product-sync', permanentField).status, 'applied');
      assert.equal(ip(['netns', 'exec', 'awgcell', 'awg', 'show', 'awgcellu8', 'peers']), '');
      assert.throws(() => ip(['netns', 'exec', 'awgdevice', 'ping', '-c', '1', '-W', '2', '198.51.100.1']));
      stage = 'synthetic-user-restoration';
      fs.writeFileSync(path.join(mainDir, 'desired-payload.json'), assigned,
        { flag: 'wx', mode: 0o600 });
      assert.equal(JSON.parse(runMainCli('publish', invitationId)).revision, 4);
      assert.equal(role('awgcell', cellDir, 'product-sync', permanentField).status, 'applied');
      assert.equal(ip(['netns', 'exec', 'awgcell', 'awg', 'show', 'awgcellu8', 'peers']),
        deviceKeys.publicKey);
      let restored = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        try { ip(['netns', 'exec', 'awgdevice', 'ping', '-c', '1', '-W', '2', '198.51.100.1']);
          restored = true; break; }
        catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
      }
      assert.equal(restored, true);
      stage = 'synthetic-geo-block';
      fs.writeFileSync(path.join(cellDir, 'geo-database.json'), JSON.stringify({
        RU: { ipv4: ['198.51.100.1/32'], ipv6: [] },
      }), { flag: 'wx', mode: 0o600 });
      const filtered = JSON.parse(assigned);
      filtered.clients[0].geoPolicy = { mode: 'block', countries: ['RU'] };
      fs.writeFileSync(path.join(mainDir, 'desired-payload.json'), JSON.stringify(filtered),
        { mode: 0o600 });
      assert.equal(JSON.parse(runMainCli('publish', invitationId)).revision, 5);
      assert.equal(role('awgcell', cellDir, 'product-sync', permanentField).status, 'applied');
      assert.throws(() => ip(['netns', 'exec', 'awgdevice', 'ping', '-c', '1', '-W', '2', '198.51.100.1']));
      stage = 'synthetic-geo-unblock';
      fs.writeFileSync(path.join(mainDir, 'desired-payload.json'), assigned,
        { mode: 0o600 });
      assert.equal(JSON.parse(runMainCli('publish', invitationId)).revision, 6);
      assert.equal(role('awgcell', cellDir, 'product-sync', permanentField).status, 'applied');
      ip(['netns', 'exec', 'awgdevice', 'ping', '-c', '3', '-W', '2', '198.51.100.1']);
      stage = 'cell-join-idempotency';
      assert.equal(runCellCli('join').status, 'ready');
      stage = 'controller-join-idempotency';
      assert.equal(JSON.parse(runMainCli('join', invitationId)).status, 'ready');
      stage = 'second-cell-registration';
      const secondInvitation = runMainCli('issue', '10.90.8.3', '10.91.8.3');
      secondId = decodeAwgBootstrapInvitation(secondInvitation).id;
      stage = 'second-cell-begin';
      assert.equal(runCellCli('begin', secondInvitation, 'awgcell2', cell2Dir).status,
        'bootstrap-ready');
      stage = 'second-cell-register';
      assert.equal(runCellCli('register', '', 'awgcell2', cell2Dir).status, 'registered');
      assert.equal(JSON.parse(runMainCli('join', secondId)).status,
        'waiting-for-permanent-path');
      stage = 'second-cell-permanent-join';
      let secondReady = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const result = runCellCli('join', '', 'awgcell2', cell2Dir);
        if (result.status === 'ready') { secondReady = true; break; }
        assert.equal(result.status, 'waiting-for-permanent-path');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.equal(secondReady, true);
      assert.equal(JSON.parse(runMainCli('join', secondId)).status, 'ready');
      assert.equal(role('awgcell2', cell2Dir, 'product-status', permanentField).permanentReady, true);
      stage = 'second-cell-settings-isolation';
      fs.unlinkSync(path.join(mainDir, 'desired-payload.json'));
      assert.equal(JSON.parse(runMainCli('publish', secondId)).revision, 1);
      assert.equal(role('awgcell2', cell2Dir, 'sync', permanentField).status, 'applied');
      const secondStatus = JSON.parse(runMainCli('settings-status', secondId));
      const firstStatus = JSON.parse(runMainCli('settings-status', invitationId));
      assert.equal(secondStatus.confirmedRevision, 1);
      assert.equal(firstStatus.confirmedRevision, 6);
      stage = 'first-cell-survives-expansion';
      ip(['netns', 'exec', 'awgdevice', 'ping', '-c', '2', '-W', '2', endpoint]);
    } finally { recovered.child.kill('SIGTERM'); }
    await stopped(recovered.child);
    stage = 'main-service-restart';
    listener.child.kill('SIGTERM');
    await stopped(listener.child);
    const service = startMainService();
    try {
      await service.ready;
      const statusSnapshot = await new MainCellStatusSnapshot(path.join(statusDir, 'cells.json')).read();
      assert.equal(statusSnapshot.state, 'ready');
      assert.equal(statusSnapshot.cells.length, 2);
      assert.equal(JSON.stringify(statusSnapshot).includes('cellKey'), false);
      assert.equal(JSON.parse(runMainCli('publish', secondId)).revision, 2);
      assert.equal(role('awgcell2', cell2Dir, 'sync', permanentField).status, 'applied');
      assert.equal(JSON.parse(runMainCli('settings-status', secondId)).confirmedRevision, 2);
      assert.equal(JSON.parse(runMainCli('settings-status', invitationId)).confirmedRevision, 6);
      stage = 'cell-service-restart';
      const cellService = track(spawn('ip', ['netns', 'exec', 'awgcell', process.execPath,
        path.join(__dirname, '..', 'src', 'link-agent.js'), 'serve'], { env: env(cellDir), stdio: ['ignore', 'pipe', 'pipe'] }));
      try {
        await new Promise((resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => reject(new Error('Cell service not ready')), 15000);
          cellService.once('exit', () => { clearTimeout(timer); reject(new Error('Cell service exited')); });
          cellService.stdout.on('data', chunk => {
            output += chunk.toString('utf8');
            if (!output.includes('\n')) return;
            clearTimeout(timer);
            try { assert.deepEqual(JSON.parse(output.trim()),
              { status: 'serving', transport: 'AWG' }); resolve(); }
            catch { reject(new Error('Invalid Cell service status')); }
          });
        });
        let recoveredControl = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          if (role('awgcell', cellDir, 'product-status', permanentField).permanentReady) {
            recoveredControl = true; break;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        assert.equal(recoveredControl, true, 'Cell control must recover after service restart');
        // The daemon is intentionally fail-closed until a routing revision is
        // supplied. This fixture only publishes standalone settings.
        ip(['netns', 'exec', 'awgcell', 'nft', 'list', 'table', 'inet', 'awg_easy_3_cell_guard']);
        assert.throws(() => ip(['netns', 'exec', 'awgdevice', 'ping', '-c', '1', '-W', '2', endpoint]));
      } finally { cellService.kill('SIGTERM'); }
      await stopped(cellService);
    } finally { service.child.kill('SIGTERM'); }
    await stopped(service.child);
    stage = 'terminal-cell-owned-cleanup';
    const mainState = await new StateStore(path.join(root, 'user-state.json')).load();
    const artifact = require('../src/lib/AwgArtifacts').buildAwgArtifacts({ server: mainState.server, clients: mainState.clients });
    const configFile = path.join(root, 'main-user.conf');
    fs.writeFileSync(configFile, artifact.serverConfig, { mode: 0o600 });
    const stripped = ip(['netns', 'exec', 'awgmain', 'awg-quick', 'strip', configFile]);
    fs.writeFileSync(path.join(root, 'main-user-stripped.conf'), stripped, { mode: 0o600 });
    ip(['netns', 'exec', 'awgmain', 'amneziawg-go', 'awg0']);
    ip(['netns', 'exec', 'awgmain', 'awg', 'setconf', 'awg0', path.join(root, 'main-user-stripped.conf')]);
    ip(['-n', 'awgmain', 'address', 'add', '10.8.0.1/24', 'dev', 'awg0']);
    ip(['-n', 'awgmain', 'link', 'set', 'awg0', 'up']);
    const removalCommand = role('awgmain', mainDir, 'product-main-remove', permanentField);
    fs.writeFileSync(path.join(cellDir, 'maintenance-command.json'), JSON.stringify(removalCommand), { mode: 0o600 });
    assert.equal(role('awgcell', cellDir, 'product-cleanup', permanentField).removed, true);
    assert.equal(role('awgcell', cellDir, 'product-cleanup', permanentField).removed, true);
    assert.throws(() => ip(['-n', 'awgcell', 'link', 'show', 'awgcellp8']));
    assert.throws(() => ip(['-n', 'awgcell', 'link', 'show', 'awgcellu8']));
    stage = 'main-revokes-removed-cell-and-acknowledges';
    const receipt = role('awgcell', cellDir, 'product-receipt', permanentField);
    fs.writeFileSync(path.join(mainDir, 'removal-receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
    for (let repeat = 0; repeat < 2; repeat++) {
      const ack = role('awgmain', mainDir, 'product-main-receipt', permanentField);
      require('../src/lib/CellMaintenance').verifyReceiptAck(ack, removalCommand);
    }
    const remaining = JSON.parse(runMainCli('cells'));
    stage = 'completed-cell-hidden';
    assert.equal(remaining.length, 1); assert.equal(remaining[0].id, secondId);
    stage = 'remaining-cell-survives-removal';
    const afterRemoval = startMainService();
    try {
      await afterRemoval.ready;
      let ready = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        if (role('awgcell2', cell2Dir, 'product-status', permanentField).permanentReady) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.equal(ready, true);
      assert.equal(JSON.parse(runMainCli('cells')).length, 1);
    } finally { afterRemoval.child.kill('SIGTERM'); }
    await stopped(afterRemoval.child);
    stage = 'foreign-resource-readback';
    ip(['-n', 'awgcell', 'link', 'show', 'awgforeign2']);
    const foreignTable = JSON.parse(ip(['netns', 'exec', 'awgcell', 'nft', '-j', 'list', 'tables']));
    assert.ok(foreignTable.nftables.some(item => item.table?.name === 'foreign_keep'));
    if (process.env.AWG_LAB_EXPORT === '1') {
      assert.equal(fs.readFileSync('/out/.allow-export', 'utf8').trim(), 'synthetic-cell-only');
      await fs.promises.cp(cellDir, '/out/cell-data', { recursive: true });
      fs.chmodSync('/out/cell-data', 0o700);
      const mainIdentity = await new (require('../src/lib/ControlIdentityStore').ControlIdentityStore)(path.join(mainDir, 'identity.json')).load('controller');
      fs.writeFileSync('/out/main-identity.json', JSON.stringify(mainIdentity), { mode: 0o600 });
    }
    console.log('PASS isolated Main/two-Cell lifecycle, control recovery, settings isolation, user revocation and GeoIP filtering');
  } finally { listener.child.kill('SIGTERM'); }
}
main().catch(error => {
  for (const child of services) child.kill('SIGKILL');
  const detail = String(error.stderr || error.message || '');
  if (['boolean', 'number'].includes(typeof error.actual) && ['boolean', 'number'].includes(typeof error.expected)) {
    console.error(`Assertion actual=${error.actual} expected=${error.expected}`);
  }
  const classification = ['timeout', 'refused', 'network', 'receiver', 'connection',
    'tunnel', 'route', 'identity', 'handshake', 'revision', 'registered', 'required']
    .filter(word => detail.toLowerCase().includes(word)).join(',') || 'unclassified';
  const safeDetail = detail.split(/\r?\n/)[0].replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]').slice(0, 160);
  console.error(`Dual-netns Cell lab failed at ${stage}; status ${error.status ?? 'unknown'}; class ${classification}; ${safeDetail}; invitation and keys withheld`);
  process.exitCode = 1;
});
