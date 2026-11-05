'use strict';
// Real AWG control AND data UDP transport migration. Disposable container only;
// no working installation, profiles, public endpoints or user traffic are used.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { runProcess } = require('../src/lib/ProcessRunner');
const { AwgKeyManager } = require('../src/lib/AwgKeyManager');
const { generateOfficialProfile, renderInterfaceFields } = require('../src/lib/Awg3Config');
const { identity } = require('../src/lib/CellRegistration');
const { createAwgOwnership, inspectAwgOwnership } = require('../src/lib/CellAwgOwnership');
const { CellControlService, syncCellSettings } = require('../src/lib/CellControlService');
const { listenControlOnTunnel, exchangeOverTunnel } = require('../src/lib/CellTunnelControlTransport');
const { signControl } = require('../src/lib/CellControlProtocol');
const { CellBackupRecoveryStore } = require('../src/lib/CellBackupRecoveryStore');
const { createRecoveryMaterial, signBackupGrant, signTakeover } = require('../src/lib/BackupRecovery');
const { createRestoredEndpoint } = require('../src/lib/CellRestoredEndpoint');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function configure(directory, name, config, address) {
  const file = path.join(directory, `${name}.conf`);
  await fs.writeFile(file, config, { mode: 0o600 });
  const owner = createAwgOwnership({ interfaceName: name, config, mtu: 1280 });
  run('amneziawg-go', [name]); run('awg', ['setconf', name, file]);
  run('ip', ['link', 'set', name, 'alias', owner.ownerTag]);
  run('ip', ['link', 'set', name, 'mtu', '1280']);
  run('ip', ['address', 'add', `${address}/32`, 'dev', name]);
  run('ip', ['link', 'set', name, 'up']);
  return { spec: { owner, addresses: [`${address}/32`] } };
}
async function child(file) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  const directory = path.dirname(file);
  const plans = {};
  try {
    for (let index = 0; index < 2; index++) {
      const role = index ? 'data' : 'control', name = index ? 'restored0' : 'restorec0';
      const peer = data.planes[index];
      const config = `[Interface]\nPrivateKey=${peer.cell.privateKey}\nListenPort=${peer.cellPort}\n${data.profile}\n`
        + `[Peer]\nPublicKey=${peer.main.publicKey}\nPresharedKey=${peer.psk}\n`
        + `AllowedIPs=10.202.${91 + index}.1/32\nEndpoint=198.18.92.1:${peer.mainPort}\nPersistentKeepalive=1\n`;
      plans[role] = await configure(directory, name, config, `10.202.${91 + index}.2`);
      run('ip', ['route', 'add', `10.202.${91 + index}.1/32`, 'dev', name]);
    }
    const connection = { version: 2, status: 'registered', controllerKey: data.mainIdentity.publicKey,
      cellKey: data.cellIdentity.publicKey };
    const connectionStore = { filePath: path.join(directory, 'connection.json'), read: async () => connection };
    const options = port => ({ connectionStore, identityStore: { load: async () => data.cellIdentity },
      receiver: {}, host: port === 54121 ? '10.202.91.1' : '10.202.92.1', port, transport: 'tunnel' });
    const request = signControl({ controllerKey: data.mainIdentity.publicKey, action: 'poll' }, data.cellIdentity.privateKey);
    await assert.rejects(exchangeOverTunnel({ address: '10.202.91.1', port: 54121, request,
      controllerKey: data.mainIdentity.publicKey, timeoutMs: 500 }));
    const store = new CellBackupRecoveryStore(path.join(directory, 'backup-recovery.json'), connection);
    const material = createRecoveryMaterial(1);
    const grant = signBackupGrant(material, Buffer.from('disposable backup archive'), data.mainIdentity.privateKey);
    await store.accept(grant);
    const challenge = await store.challenge();
    await store.consume(signTakeover({ grant, material, cellKey: data.cellIdentity.publicKey,
      challenge: challenge.nonce, authorityKey: data.authority.publicKey, endpointHost: '198.18.92.3' }));
    let protectedCount = 0;
    const migration = createRestoredEndpoint({ stateDirectory: directory, connectionStore,
      permanentPlanStore: { read: async () => plans.control }, dataDeployment: {
        stateDirectory: path.join(directory, 'data-link'), store: { read: async () => plans.data },
        policyTable: 'awg_easy_3_data_cell', guardTable: 'awg_easy_3_data_guard_cell' },
      buildPath: ({ plan }) => ({ interfaceName: plan.spec.owner.interfaceName,
        verifyOwned: async () => inspectAwgOwnership({ manifest: plan.spec.owner,
          links: JSON.parse(run('ip', ['-d', '-j', 'link', 'show', 'dev', plan.spec.owner.interfaceName])),
          actualConfig: run('awg', ['showconf', plan.spec.owner.interfaceName]) }).verified }) });
    const protect = async () => { protectedCount++; };
    assert.equal((await migration.ensure({ protect })).changed, true);
    for (const port of [54121, 54122]) assert.equal((await syncCellSettings(options(port))).status, 'no-settings');
    assert.equal((await migration.ensure({ protect })).changed, false);
    assert.equal(protectedCount, 1);
    for (const role of ['control', 'data']) {
      const plan = plans[role];
      assert.equal(inspectAwgOwnership({ manifest: plan.spec.owner,
        links: JSON.parse(run('ip', ['-d', '-j', 'link', 'show', 'dev', plan.spec.owner.interfaceName])),
        actualConfig: run('awg', ['showconf', plan.spec.owner.interfaceName]) }).verified, true);
      assert(run('awg', ['show', plan.spec.owner.interfaceName, 'endpoints']).includes('198.18.92.1:'));
    }
    console.log(JSON.stringify({ realAwgControl: true, realAwgData: true, newMainAddress: true,
      oldMainUnavailable: true, originalPinnedEndpointsPreserved: true, secondPassUnchanged: true, tlsUsed: false }));
  } finally {
    for (const name of ['restorec0', 'restored0']) { try { run('ip', ['link', 'delete', name]); } catch {} }
  }
}
async function main() {
  if (process.platform !== 'linux' || process.env.AWG_DISPOSABLE_NETWORK_TEST !== '1') throw new Error('Disposable Linux test required');
  await fs.access('/.dockerenv');
  if (process.argv[2] === 'child') return child(process.argv[3]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-restored-network-'));
  const namespace = `awgr${crypto.randomBytes(4).toString('hex')}`;
  const listeners = [];
  try {
    run('ip', ['netns', 'add', namespace]);
    run('ip', ['link', 'add', 'restoreroot', 'type', 'veth', 'peer', 'name', 'restorepeer']);
    run('ip', ['link', 'set', 'restorepeer', 'netns', namespace]);
    run('ip', ['address', 'add', '198.18.92.3/29', 'dev', 'restoreroot']);
    run('ip', ['link', 'set', 'restoreroot', 'up']);
    for (const args of [['link', 'set', 'lo', 'up'], ['address', 'add', '198.18.92.2/29', 'dev', 'restorepeer'],
      ['link', 'set', 'restorepeer', 'up']]) run('ip', ['netns', 'exec', namespace, 'ip', ...args]);
    const manager = new AwgKeyManager();
    const mainIdentity = identity(), cellIdentity = identity(), authority = identity();
    const profile = renderInterfaceFields(generateOfficialProfile());
    const planes = [];
    for (let index = 0; index < 2; index++) {
      const plane = { main: await manager.generateKeyPair(), cell: await manager.generateKeyPair(),
        psk: await manager.generatePresharedKey(), mainPort: 53194 + index * 2, cellPort: 53195 + index * 2 };
      planes.push(plane);
      await configure(directory, `restores${index}`, `[Interface]\nPrivateKey=${plane.main.privateKey}\nListenPort=${plane.mainPort}\n${profile}\n`
        + `[Peer]\nPublicKey=${plane.cell.publicKey}\nPresharedKey=${plane.psk}\nAllowedIPs=10.202.${91 + index}.2/32\n`, `10.202.${91 + index}.1`);
      run('ip', ['route', 'add', `10.202.${91 + index}.2/32`, 'dev', `restores${index}`]);
      listeners.push(await listenControlOnTunnel({ address: `10.202.${91 + index}.1`, port: 54121 + index,
        handler: new CellControlService({ identityStore: { load: async () => mainIdentity },
          authorityIdentity: async () => authority,
          bootstrapStore: { read: async () => ({ version: 2, invitations: [{ status: 'consumed', phase: 'closed',
            cellKey: cellIdentity.publicKey, awgPublicKey: plane.cell.publicKey, awgPresharedKey: plane.psk }] }) },
          publisherForCell: () => ({ load: async () => null }) }) }));
    }
    const file = path.join(directory, 'child.json');
    await fs.writeFile(file, JSON.stringify({ planes, mainIdentity, cellIdentity, authority, profile }), { mode: 0o600 });
    const result = await runProcess('ip', ['netns', 'exec', namespace, process.execPath, __filename, 'child', file],
      { timeoutMs: 45000, maxOutputBytes: 4096 });
    console.log(result.stdout);
  } finally {
    for (const listener of listeners) await new Promise(resolve => listener.close(resolve));
    try { run('ip', ['netns', 'delete', namespace]); } catch {}
    for (const name of ['restoreroot', 'restores0', 'restores1']) { try { run('ip', ['link', 'delete', name]); } catch {} }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(`Disposable endpoint migration failed: ${`${error.message || ''} ${error.stderr || ''}`
    .replace(/[A-Za-z0-9+/]{43}=/g, '[redacted-test-key]').slice(0, 1200)}`);
  process.exitCode = 1;
});
