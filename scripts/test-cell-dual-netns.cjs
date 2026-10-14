'use strict';
// Disposable Main/Cell AWG registration test. Run only inside an outer
// unshare --mount --net --pid --fork --kill-child with tmpfs /tmp and /run/netns.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1');
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), fs.readlinkSync('/proc/1/ns/net'));
const netnsMount = fs.statfsSync('/run/netns');
assert.equal(netnsMount.type, 0x01021994); // tmpfs; no persistent host netns entries
const field = path.join(__dirname, 'cell-awg-direct-field.cjs');
const permanentField = path.join(__dirname, 'cell-awg-permanent-field.cjs');
const root = '/tmp/awg-cell-dual-netns';
const mainDir = path.join(root, 'main');
const cellDir = path.join(root, 'cell');
fs.mkdirSync(mainDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(cellDir, { recursive: true, mode: 0o700 });
const endpoint = '198.51.100.1';
const env = directory => ({ ...process.env, CELL_FIELD_STATE: directory,
  CELL_FIELD_CONTROLLER_PUBLIC: endpoint,
  CELL_FIELD_ROLE: directory === mainDir ? 'controller' : 'cell',
  CELL_FIELD_INTERFACE: directory === mainDir ? 'awgmain8' : 'awgcell8',
  CELL_FIELD_PERMANENT_INTERFACE: directory === mainDir ? 'awgmainp8' : 'awgcellp8' });
const ip = args => execFileSync('ip', args, { encoding: 'utf8', timeout: 30000,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const role = (namespace, directory, action, script = field) => JSON.parse(execFileSync('ip',
  ['netns', 'exec', namespace, process.execPath, script, action],
  { env: env(directory), encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'] }));
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
  ip(['link', 'add', 'veth-main', 'type', 'veth', 'peer', 'name', 'veth-cell']);
  ip(['link', 'set', 'veth-main', 'netns', 'awgmain']);
  ip(['link', 'set', 'veth-cell', 'netns', 'awgcell']);
  ip(['-n', 'awgmain', 'address', 'add', `${endpoint}/30`, 'dev', 'veth-main']);
  ip(['-n', 'awgcell', 'address', 'add', '198.51.100.2/30', 'dev', 'veth-cell']);
  for (const [ns, iface] of [['awgmain', 'veth-main'], ['awgcell', 'veth-cell']]) {
    ip(['-n', ns, 'link', 'set', iface, 'up']);
    ip(['-n', ns, 'link', 'set', 'lo', 'up']);
  }
  stage = 'controller-init';
  assert.equal(role('awgmain', mainDir, 'controller-init').ready, true);
  stage = 'controller-issue';
  assert.equal(role('awgmain', mainDir, 'controller-issue').issued, true);
  fs.copyFileSync(path.join(mainDir, 'invitation'), path.join(cellDir, 'invitation'));
  fs.chmodSync(path.join(cellDir, 'invitation'), 0o600);
  stage = 'cell-begin';
  assert.equal(role('awgcell', cellDir, 'cell-begin').pending, true);
  stage = 'cell-provision';
  assert.equal(role('awgcell', cellDir, 'cell-provision').ready, true);
  stage = 'registration';
  const listener = listen();
  try {
    await listener.ready;
    assert.equal(role('awgcell', cellDir, 'cell-register').status, 'registered');
    const cell = role('awgcell', cellDir, 'cell-status');
    const controller = role('awgmain', mainDir, 'controller-status');
    assert.equal(cell.connection, 'registered');
    assert.equal(controller.verified, true);
    assert.equal(controller.invitations[0].status, 'consumed');
    stage = 'permanent-controller-init';
    assert.equal(role('awgmain', mainDir, 'permanent-init', permanentField).permanentReady, true);
    stage = 'permanent-cell-init';
    assert.equal(role('awgcell', cellDir, 'permanent-init', permanentField).permanentReady, true);
    stage = 'permanent-handshake';
    let ready = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const main = role('awgmain', mainDir, 'status', permanentField);
      const peer = role('awgcell', cellDir, 'status', permanentField);
      if (main.permanentReady && peer.permanentReady) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(ready, true);
    stage = 'temporary-retirement';
    role('awgmain', mainDir, 'controller-close', permanentField);
    role('awgcell', cellDir, 'cell-retire', permanentField);
    stage = 'control-sync';
    const control = listen(permanentField, 'control-listen', 'controlListening');
    try {
      await control.ready;
      stage = 'control-publish';
      assert.equal(role('awgmain', mainDir, 'publish', permanentField).revision, 1);
      stage = 'control-sync-request';
      const result = role('awgcell', cellDir, 'sync', permanentField);
      assert.equal(result.status, 'applied');
      stage = 'control-sync-ack';
      const synced = role('awgmain', mainDir, 'status', permanentField);
      assert.equal(synced.applied, synced.desired);
    } finally { control.child.kill('SIGTERM'); }
    assert.equal(role('awgmain', mainDir, 'status', permanentField).permanentReady, true);
    assert.equal(role('awgcell', cellDir, 'status', permanentField).permanentReady, true);
    console.log('PASS two isolated network namespaces register, sync, and retire bootstrap over real AWG');
  } finally { listener.child.kill('SIGTERM'); }
}
main().catch(error => {
  const detail = String(error.stderr || error.message || '');
  const classification = ['timeout', 'refused', 'network', 'receiver', 'connection',
    'tunnel', 'route', 'identity', 'handshake', 'revision', 'registered', 'required']
    .filter(word => detail.toLowerCase().includes(word)).join(',') || 'unclassified';
  console.error(`Dual-netns Cell lab failed at ${stage}; status ${error.status ?? 'unknown'}; class ${classification}; invitation and keys withheld`);
  process.exitCode = 1;
});
