'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateOfficialProfile } = require('../lib/Awg3Config');
const { StateStore } = require('../lib/StateStore');
const { sealBackup } = require('../lib/BackupEnvelope');
const { captureConfiguration, decodeConfiguration, stageConfiguration,
  prepareRestoredPanelState } = require('../lib/BackupSnapshot');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-backup-snapshot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const panel = path.join(directory, 'original');
  await fs.mkdir(panel, { mode: 0o700 });
  const state = { version: 3, auth: { passwordHash: 'existing-password-hash', sessionSecret: 'old-cookie-secret',
    mode: 'password_totp', totpSecret: 'A'.repeat(32), lastTotpStep: 100,
    pendingTotp: { secret: 'B'.repeat(32), createdAt: 100 } },
    server: { interfaceName: 'awg0', wanInterface: 'oldwan0', endpointHost: 'old.example.test',
      listenPort: 51820, panelPort: 51821, privateKey: 'retained-server-secret', publicKey: 'retained-server-public',
      address4: '10.8.0.1', ipv4Subnet: '10.8.0.0/24', address6: 'fd35:e03:5563::1',
      ipv6Subnet: 'fd35:e03:5563::/64', ipv6Mode: 'nat66', profile: generateOfficialProfile() },
    clients: [{ id: 'admin', name: 'Миша', networkGroup: 'home', enabled: true,
      address4: '10.8.0.2', address6: 'fd35:e03:5563::2', privateKey: 'retained-client-secret',
      publicKey: 'retained-client-public', presharedKey: 'retained-client-psk' }] };
  await new StateStore(path.join(panel, 'state.json')).save(state);
  const options = { panelDirectory: panel, files: [{ area: 'panel', name: 'state.json' }],
    withQuiesced: work => work(), now: () => 123456 };
  return { directory, panel, state, options };
}

test('encrypted configuration snapshot stages an exact private copy without touching the original', async t => {
  const f = await fixture(t);
  const sealed = await captureConfiguration(f.options);
  assert.equal(sealed.archive.includes(Buffer.from('retained-client-secret')), false);
  const snapshot = decodeConfiguration(sealed.archive, sealed.recoveryKey);
  assert.equal(snapshot.createdAt, 123456);
  const stage = path.join(f.directory, 'stage');
  assert.deepEqual(await stageConfiguration(snapshot, stage), { staged: true, files: 1 });
  assert.deepEqual(await fs.readFile(path.join(stage, 'panel/state.json')), await fs.readFile(path.join(f.panel, 'state.json')));
  const restored = await new StateStore(path.join(stage, 'panel/state.json')).load();
  assert.equal(restored.clients[0].name, 'Миша');
  assert.equal(restored.auth.mode, 'password_totp');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(stage)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(stage, 'panel/state.json'))).mode & 0o777, 0o600);
  }
  await assert.rejects(stageConfiguration(snapshot, stage), { code: 'EEXIST' });
  const other = await captureConfiguration(f.options);
  assert.throws(() => decodeConfiguration(sealed.archive, other.recoveryKey), /Invalid configuration/);
});

test('snapshot rejects traversal, kernel journals, duplicate files, partial Main metadata and invalid hashes', async t => {
  const f = await fixture(t);
  for (const name of ['../state.json', '/etc/passwd', 'bootstrap/awg.json', 'discovery/contacts.json', 'cell-observed/state.json']) {
    await assert.rejects(captureConfiguration({ ...f.options, files: [{ area: 'main', name }], mainDirectory: f.panel }));
  }
  await assert.rejects(captureConfiguration({ ...f.options, files: [f.options.files[0], f.options.files[0]] }));
  await fs.writeFile(path.join(f.panel, 'identity.json'), '{}', { mode: 0o600 });
  await assert.rejects(captureConfiguration({ ...f.options, mainDirectory: f.panel,
    files: [...f.options.files, { area: 'main', name: 'identity.json' }] }));
  const sealed = await captureConfiguration(f.options);
  const snapshot = decodeConfiguration(sealed.archive, sealed.recoveryKey);
  snapshot.files[0].sha256 = '0'.repeat(64);
  const forged = sealBackup(Buffer.from(JSON.stringify(snapshot)));
  assert.throws(() => decodeConfiguration(forged.archive, forged.recoveryKey), /Invalid configuration/);
});

test('snapshot refuses symlinked/private-permission sources instead of following them', async t => {
  const f = await fixture(t);
  if (process.platform === 'win32') {
    // Windows symlink creation may need developer mode; junction creation does not.
    const junction = path.join(f.directory, 'junction');
    await fs.symlink(f.panel, junction, 'junction');
    await assert.rejects(captureConfiguration({ ...f.options, panelDirectory: junction }), /Private backup/);
  } else {
    await fs.chmod(path.join(f.panel, 'state.json'), 0o644);
    await assert.rejects(captureConfiguration(f.options), /Unsafe backup source/);
    await fs.chmod(path.join(f.panel, 'state.json'), 0o600);
    await fs.rename(path.join(f.panel, 'state.json'), path.join(f.directory, 'external.json'));
    await fs.symlink(path.join(f.directory, 'external.json'), path.join(f.panel, 'state.json'));
    await assert.rejects(captureConfiguration(f.options));
  }
});

test('restore preparation preserves VPN/ULA/client identities and TOTP while replacing new-host bindings and cookie secret', async t => {
  const f = await fixture(t);
  const sealed = await captureConfiguration(f.options);
  const snapshot = decodeConfiguration(sealed.archive, sealed.recoveryKey);
  const target = { interfaceName: 'awg3', wanInterface: 'newwan0', endpointHost: '198.51.100.1', listenPort: 53000, panelPort: 80 };
  const next = prepareRestoredPanelState(snapshot, target);
  assert.equal(next.server.endpointHost, target.endpointHost);
  assert.equal(next.server.wanInterface, 'newwan0');
  assert.equal(next.server.address6, f.state.server.address6);
  assert.equal(next.server.ipv6Subnet, f.state.server.ipv6Subnet);
  assert.equal(next.server.privateKey, f.state.server.privateKey);
  assert.equal(next.clients[0].privateKey, f.state.clients[0].privateKey);
  assert.equal(next.auth.totpSecret, f.state.auth.totpSecret);
  assert.equal(next.auth.pendingTotp, undefined);
  assert.notEqual(next.auth.sessionSecret, f.state.auth.sessionSecret);
  assert.equal(crypto.timingSafeEqual(Buffer.from(next.auth.sessionSecret), Buffer.from(prepareRestoredPanelState(snapshot, target).auth.sessionSecret)), false);
  assert.throws(() => prepareRestoredPanelState(snapshot, { ...target, ipv6Subnet: 'fd00::/64' }));
});
