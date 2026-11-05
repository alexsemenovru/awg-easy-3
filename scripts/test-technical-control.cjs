'use strict';

// End-to-end signed control RPC through encrypted AWG and one relay, with
// client and controller in DIFFERENT network namespaces. Disposable container
// only: NET_ADMIN, SYS_ADMIN, /dev/net/tun and seccomp=unconfined are required.
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
const { listenControlOnTunnel } = require('../src/lib/CellTunnelControlTransport');
const { AwgTechnicalRelay, openTechnicalBridge } = require('../src/lib/AwgTechnicalRelay');
const { CellControlRedirect } = require('../src/lib/CellControlRedirect');
const { CellTechnicalFailover } = require('../src/lib/CellTechnicalFailover');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function configure(directory, name, config, address) {
  const file = path.join(directory, `${name}.conf`);
  await fs.writeFile(file, config, { mode: 0o600 });
  const owner = createAwgOwnership({ interfaceName: name, config, mtu: 1280 });
  run('amneziawg-go', [name]);
  run('awg', ['setconf', name, file]);
  run('ip', ['link', 'set', name, 'alias', owner.ownerTag]);
  run('ip', ['link', 'set', name, 'mtu', '1280']);
  run('ip', ['address', 'add', `${address}/32`, 'dev', name]);
  run('ip', ['link', 'set', name, 'up']);
  return owner;
}

async function child(file) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  let bridge;
  let automatic;
  try {
    // Reject the original UDP path even before setconf can send a keepalive.
    run('nft', ['add', 'table', 'ip', 'technical_probe']);
    run('nft', ['add', 'chain', 'ip', 'technical_probe', 'output', '{ type filter hook output priority 0; policy accept; }']);
    run('nft', ['add', 'rule', 'ip', 'technical_probe', 'output', 'udp', 'sport', '53185', 'udp', 'dport', '53184', 'drop']);
    const config = `[Interface]\nPrivateKey = ${data.privateKey}\nListenPort = 53185\n${data.profile}\n`
      + `[Peer]\nPublicKey = ${data.serverKey}\nPresharedKey = ${data.psk}\n`
      + 'AllowedIPs = 10.201.91.1/32\nEndpoint = 198.18.91.1:53184\nPersistentKeepalive = 1\n';
    const owner = await configure(path.dirname(file), 'techclient', config, '10.201.91.2');
    run('ip', ['route', 'add', '10.201.91.1/32', 'dev', 'techclient']);
    const redirect = new CellControlRedirect({ directory: path.join(path.dirname(file), 'redirect'),
      verifyOwned: async value => value.interfaceName === 'techclient' && value.ownerTag === owner.ownerTag
        && inspectAwgOwnership({ manifest: owner,
          links: JSON.parse(run('ip', ['-d', '-j', 'link', 'show', 'dev', 'techclient'])),
          actualConfig: run('awg', ['showconf', 'techclient']) }).verified });
    const tuple = { interfaceName: 'techclient', ownerTag: owner.ownerTag,
      source4: '198.18.91.2', sourcePort: 53185, peer4: '198.18.91.1', peerPort: 53184 };
    automatic = new CellTechnicalFailover({ directory: path.join(path.dirname(file), 'redirect'),
      snapshot: async () => ({ target: data.mainKey, tuple }), locked: work => work(), redirect,
      discovery: () => ({
        openBridge: async () => {
          bridge = await openTechnicalBridge({ host: '198.18.91.1', port: data.relayPort,
            serverKey: data.relayKey, target: data.mainKey, kind: 'main',
            identity: data.cellIdentity, localAwgPort: 53185, localAwgAddress: tuple.source4 });
          return bridge.address;
        }, closeBridge: async () => { if (bridge) await bridge.close(); },
        status: () => ({ technical: { bridgeActive: !!bridge } }),
      }) });
    await automatic.prepare();
    automatic.report({ state: 'degraded', consecutiveFailures: 3 });
    await automatic.pending;
    assert.equal(automatic.status, 'technical');
    const options = { connectionStore: { read: async () => ({ version: 2, status: 'registered',
      controllerKey: data.mainKey, cellKey: data.cellIdentity.publicKey }) },
      identityStore: { load: async () => data.cellIdentity }, receiver: {},
      host: '10.201.91.1', port: 54111, transport: 'tunnel' };
    const result = await syncCellSettings(options);
    assert.equal(result.status, 'no-settings');
    assert(run('awg', ['show', 'techclient', 'endpoints']).trim().endsWith('198.18.91.1:53184'));
    console.log(JSON.stringify({ signedControlRpc: true, automaticReserve: true,
      separateNetworkNamespaces: true, originalUdpBlocked: true, endpointPreserved: true, tlsUsed: false }));
  } finally {
    if (automatic) await automatic.close();
    if (bridge) await bridge.close();
    try { run('ip', ['link', 'delete', 'techclient']); } catch { /* Not created. */ }
  }
}

async function main() {
  if (process.platform !== 'linux' || process.env.AWG_DISPOSABLE_NETWORK_TEST !== '1') throw new Error('Disposable Linux test required');
  await fs.access('/.dockerenv');
  if (process.argv[2] === 'child') return child(process.argv[3]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-technical-control-'));
  const namespace = `awgt${crypto.randomBytes(4).toString('hex')}`;
  let relay;
  let receiver;
  let control;
  try {
    run('ip', ['netns', 'add', namespace]);
    run('ip', ['link', 'add', 'techroot', 'type', 'veth', 'peer', 'name', 'techpeer']);
    run('ip', ['link', 'set', 'techpeer', 'netns', namespace]);
    run('ip', ['address', 'add', '198.18.91.1/30', 'dev', 'techroot']);
    run('ip', ['link', 'set', 'techroot', 'up']);
    for (const args of [['link', 'set', 'lo', 'up'], ['address', 'add', '198.18.91.2/30', 'dev', 'techpeer'],
      ['link', 'set', 'techpeer', 'up']]) run('ip', ['netns', 'exec', namespace, 'ip', ...args]);
    const manager = new AwgKeyManager();
    const server = await manager.generateKeyPair();
    const client = await manager.generateKeyPair();
    const psk = await manager.generatePresharedKey();
    const profile = renderInterfaceFields(generateOfficialProfile());
    const mainIdentity = identity(); const cellIdentity = identity(); const relayIdentity = identity();
    await configure(directory, 'techserver', `[Interface]\nPrivateKey = ${server.privateKey}\nListenPort = 53184\n${profile}\n`
      + `[Peer]\nPublicKey = ${client.publicKey}\nPresharedKey = ${psk}\nAllowedIPs = 10.201.91.2/32\n`, '10.201.91.1');
    run('ip', ['route', 'add', '10.201.91.2/32', 'dev', 'techserver']);
    control = await listenControlOnTunnel({ address: '10.201.91.1', port: 54111,
      handler: new CellControlService({ identityStore: { load: async () => mainIdentity },
        bootstrapStore: { read: async () => ({ version: 2, invitations: [{ status: 'consumed', phase: 'closed',
          cellKey: cellIdentity.publicKey, awgPublicKey: client.publicKey, awgPresharedKey: psk }] }) },
        publisherForCell: () => ({ load: async () => ({ desired: null }) }) }) });
    receiver = await new AwgTechnicalRelay({ identity: mainIdentity, kind: 'main', controlPort: 53184,
      allowedPeer: key => key === cellIdentity.publicKey, lookup: async () => null }).start(0, '127.0.0.1');
    relay = await new AwgTechnicalRelay({ identity: relayIdentity, kind: 'cell', controlPort: null,
      allowedPeer: () => false, allowAddress: () => true,
      lookup: async key => key === mainIdentity.publicKey ? { host: '127.0.0.1', port: receiver.address().port } : null,
    }).start(0, '198.18.91.1');
    const file = path.join(directory, 'child.json');
    await fs.writeFile(file, JSON.stringify({ privateKey: client.privateKey, serverKey: server.publicKey,
      psk, profile, cellIdentity, mainKey: mainIdentity.publicKey, relayKey: relayIdentity.publicKey,
      relayPort: relay.address().port }), { mode: 0o600 });
    const result = await runProcess('ip', ['netns', 'exec', namespace, process.execPath,
      __filename, 'child', file], { timeoutMs: 45000, maxOutputBytes: 4096 });
    assert(relay.stats.forwardedBytes > 0);
    console.log(result.stdout);
  } finally {
    if (relay) await relay.close();
    if (receiver) await receiver.close();
    if (control) await new Promise(resolve => control.close(resolve));
    try { run('ip', ['netns', 'delete', namespace]); } catch { /* Not created. */ }
    for (const name of ['techroot', 'techserver']) { try { run('ip', ['link', 'delete', name]); } catch { /* Not created. */ } }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(`Disposable technical control failed: ${`${error.message || ''} ${error.stderr || ''}`
    .replace(/[A-Za-z0-9+/]{43}=/g, '[redacted-test-key]').slice(0, 1200)}`);
  process.exitCode = 1;
});
