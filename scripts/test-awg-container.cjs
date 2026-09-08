'use strict';

// Runs only inside disposable Docker test containers, never against a user's VPS.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const { isDeepStrictEqual } = require('node:util');
const { StateStore } = require('/app/lib/StateStore');
const { BootstrapInstaller } = require('/app/lib/BootstrapInstaller');
const { AwgKeyManager } = require('/app/lib/AwgKeyManager');
const { buildAwgArtifacts } = require('/app/lib/AwgArtifacts');
const { ClientManager } = require('/app/lib/ClientManager');
const { RuntimeApplier } = require('/app/lib/RuntimeApplier');
const store = new StateStore('/data/state.json');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const mode = process.argv[2];

async function main() {
  if (mode === 'fixture') {
    const { state } = await new BootstrapInstaller({
      store,
      networkDetector: { detect: async () => ({ endpointCandidate: process.argv[3], wanInterface: 'eth0', ipv6: { available: false } }) },
    }).install({ endpointHost: process.argv[3], listenPort: 54321, ipv6: { serverAddress: 'fd42:8:3::1', firstClientAddress: 'fd42:8:3::2', subnet: 'fd42:8:3::/64', mode: 'routed' } });
    const clients = [...state.clients];
    for (const [id, number, networkGroup, ipv4Enabled, ipv6Enabled] of [
      ['probe', 3, 'home', true, true], ['guest', 4, 'guest', true, true],
      ['disabled', 5, 'home', false, false], ['v6-only', 6, 'home', false, true],
    ]) clients.push({ id, name: id, networkGroup, enabled: ipv4Enabled || ipv6Enabled, ipv4Enabled, ipv6Enabled,
      address4: `10.8.0.${number}`, address6: `fd42:8:3::${number}`, ...await new AwgKeyManager().generatePeerKeys() });
    const saved = await store.save({ ...state, clients });
    const artifacts = buildAwgArtifacts(saved);
    await fs.writeFile('/data/before.json', JSON.stringify(saved), { mode: 0o600 });
    await fs.writeFile('/data/artifacts.json', JSON.stringify(artifacts), { mode: 0o600 });
    for (const [id, artifact] of Object.entries(artifacts.clientArtifacts)) {
      await fs.writeFile(`/data/${id}.conf`, artifact.nativeConfig, { mode: 0o600 });
    }
    console.log('Fixture and profiles created with the previous release.');
  } else if (mode === 'snapshot') {
    const state = await store.load();
    // Compare without printing private keys or profile links on assertion failure.
    assert(isDeepStrictEqual(JSON.parse(JSON.stringify(state)), JSON.parse(await fs.readFile('/data/before.json', 'utf8'))), 'Persisted state changed');
    assert(isDeepStrictEqual(JSON.parse(JSON.stringify(buildAwgArtifacts(state))), JSON.parse(await fs.readFile('/data/artifacts.json', 'utf8'))), 'Exported artifacts changed');
    const peers = run('awg', ['show', 'awg0', 'peers']).trim().split('\n');
    assert(!peers.includes(state.clients.find(c => c.id === 'disabled').publicKey));
    console.log('State, keys, auth, ports, permissions and all exports unchanged; disabled peer absent.');
  } else if (mode === 'client') {
    const id = process.argv[3];
    const config = await fs.readFile(`/data/${id}.conf`, 'utf8');
    // Preserve wire parameters. Only test tunnel routes are installed; DNS and
    // Internet routing belong to the separate client compatibility matrix.
    const native = config.split('\n').filter(l => !/^(Address|DNS|MTU)\s*=/.test(l)).join('\n');
    await fs.writeFile('/tmp/probe.conf', native, { mode: 0o600 });
    run('amneziawg-go', ['awgprobe']);
    run('awg', ['setconf', 'awgprobe', '/tmp/probe.conf']);
    const client = (await store.load()).clients.find(c => c.id === id);
    run('ip', ['address', 'add', `${client.address4}/24`, 'dev', 'awgprobe']);
    run('ip', ['-6', 'address', 'add', `${client.address6}/64`, 'dev', 'awgprobe', 'nodad']);
    run('ip', ['link', 'set', 'dev', 'awgprobe', 'mtu', '1280', 'up']);
    http.createServer((req, res) => { req.pipe(res); }).listen(8080, '::');
    console.log('Test client ready.');
  } else if (mode === 'echo') {
    http.createServer((req, res) => { req.pipe(res); }).listen(8080, '::');
  } else if (mode === 'traffic') {
    const host = process.argv[3], port = Number(process.argv[4]), expected = process.argv[5];
    const payload = Buffer.alloc(Number(process.argv[6] || 65536), 0x5a);
    try {
      const received = await new Promise((resolve, reject) => {
        const req = http.request({ host, port, path: port === 51821 ? '/api/v1/session' : '/', method: port === 51821 ? 'GET' : 'POST' }, res => {
          const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
        });
        const timer = setTimeout(() => req.destroy(Object.assign(new Error('test timeout'), { code: 'ETIMEDOUT' })), 12000);
        req.on('close', () => clearTimeout(timer)); req.on('error', reject);
        req.end(port === 51821 ? undefined : payload);
      });
      assert.equal(expected, 'allow', 'Forbidden traffic was delivered');
      if (port !== 51821) assert(received.equals(payload), 'Echo payload changed');
      console.log(`PASS allowed IPv${host.includes(':') ? 6 : 4} port ${port}, ${received.length} bytes`);
    } catch (error) {
      if (expected !== 'block' || !['ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)) throw error;
      console.log(`PASS blocked IPv${host.includes(':') ? 6 : 4} port ${port}`);
    }
  } else if (mode === 'permissions') {
    const manager = new ClientManager({ store, applier: new RuntimeApplier({ runtimeDirectory: '/run/awg-easy-3' }) });
    await manager.updateClient('probe', { ipv4Enabled: process.argv[3] === 'on', ipv6Enabled: process.argv[4] === 'on' });
  } else throw new Error('Unknown integration test mode');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
