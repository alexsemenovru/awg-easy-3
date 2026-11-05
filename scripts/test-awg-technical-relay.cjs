'use strict';

// Only in a disposable, NET_ADMIN-enabled Linux test container. Creates two
// control-only AWG devices and proves an actual handshake through a third key's
// TCP relay. It never configures Internet routes or reads real client profiles.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { identity } = require('../src/lib/CellRegistration');
const { AwgKeyManager } = require('../src/lib/AwgKeyManager');
const { generateOfficialProfile, renderInterfaceFields } = require('../src/lib/Awg3Config');
const { AwgTechnicalRelay, openTechnicalBridge } = require('../src/lib/AwgTechnicalRelay');
const { CellControlRedirect } = require('../src/lib/CellControlRedirect');
const { CellTechnicalFailover } = require('../src/lib/CellTechnicalFailover');
const { createAwgOwnership, inspectAwgOwnership } = require('../src/lib/CellAwgOwnership');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function main() {
  if (process.platform !== 'linux' || process.env.AWG_DISPOSABLE_NETWORK_TEST !== '1') {
    throw new Error('Explicit disposable Linux network test required');
  }
  await fs.access('/.dockerenv');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-tech-handshake-'));
  let server;
  let relay;
  let bridge;
  let redirect;
  let automatic;
  let clock = Date.now();
  const automaticMode = process.argv[2] === 'auto';
  const redirectMode = automaticMode || process.argv[2] === 'redirect';
  try {
    const manager = new AwgKeyManager();
    const a = await manager.generateKeyPair();
    const b = await manager.generateKeyPair();
    const psk = await manager.generatePresharedKey();
    const profile = renderInterfaceFields(generateOfficialProfile());
    const mainId = identity(); const cellId = identity(); const relayId = identity();
    const source4 = redirectMode ? '198.18.0.1' : '127.0.0.1';
    const peer4 = redirectMode ? '198.18.0.2' : '127.0.0.1';
    if (redirectMode) {
      run('ip', ['address', 'add', `${source4}/32`, 'dev', 'lo']);
      run('ip', ['address', 'add', `${peer4}/32`, 'dev', 'lo']);
      run('ip', ['route', 'replace', 'local', `${peer4}/32`, 'dev', 'lo', 'src', source4, 'table', 'local']);
    }
    server = await new AwgTechnicalRelay({ identity: mainId, kind: 'main', controlPort: 53184,
      allowedPeer: key => key === cellId.publicKey, lookup: async () => null }).start(0, '127.0.0.1');
    relay = await new AwgTechnicalRelay({ identity: relayId, kind: 'cell', controlPort: null,
      allowedPeer: () => false, allowAddress: () => true,
      lookup: async key => key === mainId.publicKey ? { host: '127.0.0.1', port: server.address().port } : null,
    }).start(0, '127.0.0.1');
    bridge = await openTechnicalBridge({ host: '127.0.0.1', port: relay.address().port,
      serverKey: relayId.publicKey, target: mainId.publicKey, kind: 'main',
      identity: cellId, localAwgPort: 53185, localAwgAddress: source4 });
    if (redirectMode) {
      // Direct AWG is deliberately unusable, including keepalives emitted by
      // setconf before link-up. Output NAT runs before this filter hook.
      run('nft', ['add', 'table', 'ip', 'technical_probe']);
      run('nft', ['add', 'chain', 'ip', 'technical_probe', 'output',
        '{ type filter hook output priority 0; policy accept; }']);
      run('nft', ['add', 'rule', 'ip', 'technical_probe', 'output',
        'udp', 'sport', '53185', 'udp', 'dport', '53184', 'drop']);
    }
    const configurations = [
      ['ctls', b.privateKey, 53184, a.publicKey, '10.201.91.2/32', ''],
      ['ctla', a.privateKey, 53185, b.publicKey, '10.201.91.1/32',
        `Endpoint = ${peer4}:${redirectMode ? 53184 : bridge.address.port}\nPersistentKeepalive = 1\n`],
    ];
    for (const [name, secret, port, peerKey, allowed, extra] of configurations) {
      const file = path.join(directory, `${name}.conf`);
      const config = `[Interface]\nPrivateKey = ${secret}\nListenPort = ${port}\n${profile}\n`
        + `\n[Peer]\nPublicKey = ${peerKey}\nPresharedKey = ${psk}\nAllowedIPs = ${allowed}\n${extra}`;
      await fs.writeFile(file, config, { mode: 0o600 });
      run('amneziawg-go', [name]);
      run('awg', ['setconf', name, file]);
      if (name === 'ctla' && redirectMode) {
        const owner = createAwgOwnership({ interfaceName: name, config, mtu: 1280 });
        run('ip', ['link', 'set', name, 'alias', owner.ownerTag]);
        run('ip', ['link', 'set', name, 'mtu', '1280']);
        redirect = new CellControlRedirect({ directory: path.join(directory, 'redirect'),
          verifyOwned: async value => value.ownerTag === owner.ownerTag && value.interfaceName === name
            && inspectAwgOwnership({ manifest: owner,
              links: JSON.parse(run('ip', ['-d', '-j', 'link', 'show', 'dev', name])),
              actualConfig: run('awg', ['showconf', name]) }).verified });
        const tuple = { interfaceName: name, ownerTag: owner.ownerTag,
          source4, sourcePort: 53185, peer4, peerPort: 53184 };
        if (automaticMode) {
          run('ip', ['link', 'set', name, 'up']);
          automatic = new CellTechnicalFailover({ directory: path.join(directory, 'redirect'),
            snapshot: async () => ({ target: mainId.publicKey, tuple }),
            locked: work => work(), redirect, now: () => clock,
            discovery: () => ({ openBridge: async () => bridge.address,
              closeBridge: async () => {}, status: () => ({ technical: { bridgeActive: true } }) }) });
          await automatic.prepare();
          automatic.report({ state: 'degraded', consecutiveFailures: 3 });
          await automatic.pending;
          assert.equal(automatic.status, 'technical');
        } else await redirect.apply({ ...tuple, bridgePort: bridge.address.port });
      }
      run('ip', ['link', 'set', name, 'up']);
    }
    const completed = name => run('awg', ['show', name, 'latest-handshakes']).trim().split(/\s+/)
      .some((value, index) => index % 2 === 1 && Number(value) > 0);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && (!completed('ctla') || !completed('ctls') || !relay.stats.forwardedBytes)) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(completed('ctla') && completed('ctls'), 'Control AWG handshake did not cross the technical relay');
    assert(relay.stats.forwardedBytes > 0, 'Relay did not carry the encrypted datagrams');
    if (redirectMode) assert(run('awg', ['show', 'ctla', 'endpoints']).trim().endsWith(`${peer4}:53184`),
      'Transparent technical path changed the pinned AWG endpoint');
    if (automaticMode) {
      clock += 300000;
      automatic.report({ state: 'connected', consecutiveFailures: 0 });
      await automatic.pending;
      assert.equal(automatic.status, 'direct');
      assert.equal(await redirect.read(), null);
      assert.equal(await redirect.current(), null);
    }
    console.log(JSON.stringify({ awgHandshake: true, intermediateUsed: true,
      transparentRedirectUsed: redirectMode, originalEndpointPreserved: redirectMode,
      automaticFailoverUsed: automaticMode, automaticDirectRetry: automaticMode,
      forwardedBytes: relay.stats.forwardedBytes, tlsUsed: false }));
  } finally {
    if (automatic) await automatic.close();
    if (redirect) await redirect.recover();
    if (redirectMode) { try { run('nft', ['delete', 'table', 'ip', 'technical_probe']); } catch { /* Not created. */ } }
    for (const name of ['ctla', 'ctls']) { try { run('ip', ['link', 'delete', name]); } catch { /* Not created. */ } }
    if (bridge) await bridge.close();
    if (relay) await relay.close();
    if (server) await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  const detail = `${error.message || ''} ${String(error.stderr || '')}`
    .replace(/[A-Za-z0-9+/]{43}=/g, '[redacted-test-key]').slice(0, 1000);
  console.error(`Disposable control AWG relay test failed: ${detail}`);
  process.exitCode = 1;
});
