'use strict';

// Run only inside the disposable mount/network/PID namespace lab wrapper.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { CellRuntimeAdapter } = require('../src/lib/CellRuntimeAdapter');
const { RuntimeApplier } = require('../src/lib/RuntimeApplier');
const { generateOfficialProfile } = require('../src/lib/Awg3Config');
const { renderClientConfig } = require('../src/lib/AwgConfigRenderer');
const { runProcess } = require('../src/lib/ProcessRunner');
const run = (file, args, input) => execFileSync(file, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

async function main() {
  assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1', 'Requires isolated lab wrapper');
  run('ip', ['link', 'set', 'lo', 'up']);
  run('ip', ['netns', 'add', 'wanlab']);
  run('ip', ['netns', 'add', 'clientlab']);
  run('ip', ['link', 'add', 'wan-test', 'type', 'veth', 'peer', 'name', 'wan-peer']);
  run('ip', ['link', 'set', 'wan-peer', 'netns', 'wanlab']);
  run('ip', ['addr', 'add', '198.51.100.1/24', 'dev', 'wan-test']);
  run('ip', ['-6', 'addr', 'add', 'fd99::1/64', 'dev', 'wan-test', 'nodad']);
  run('ip', ['link', 'set', 'wan-test', 'up']);
  const ns = (name, cmd, args, input) => run('ip', ['netns', 'exec', name, cmd, ...args], input);
  for (const args of [['link', 'set', 'lo', 'up'], ['addr', 'add', '198.51.100.2/24', 'dev', 'wan-peer'],
    ['-6', 'addr', 'add', 'fd99::2/64', 'dev', 'wan-peer', 'nodad'], ['link', 'set', 'wan-peer', 'up']]) ns('wanlab', 'ip', args);
  run('ip', ['link', 'add', 'underlay', 'type', 'veth', 'peer', 'name', 'client-peer']);
  run('ip', ['link', 'set', 'client-peer', 'netns', 'clientlab']);
  run('ip', ['addr', 'add', '192.0.2.1/24', 'dev', 'underlay']);
  run('ip', ['link', 'set', 'underlay', 'up']);
  for (const args of [['link', 'set', 'lo', 'up'], ['addr', 'add', '192.0.2.2/24', 'dev', 'client-peer'],
    ['link', 'set', 'client-peer', 'up']]) ns('clientlab', 'ip', args);
  run('sysctl', ['-w', 'net.ipv4.ip_forward=1']);
  run('sysctl', ['-w', 'net.ipv6.conf.all.forwarding=1']);
  run('nft', ['-f', '-'], 'table inet unrelated_test {\n chain keep {\n }\n}\n');
  const privateKey = run('awg', ['genkey']);
  const clientPrivate = run('awg', ['genkey']);
  const clientKey = run('awg', ['pubkey'], clientPrivate + '\n');
  const server = { interfaceName: 'awgcelltest', wanInterface: 'wan-test', privateKey,
    address4: '10.88.0.1', ipv4Subnet: '10.88.0.0/24', address6: 'fd88::1', ipv6Subnet: 'fd88::/64',
    ipv6Mode: 'nat66', listenPort: 54321, profile: generateOfficialProfile() };
  const settings = { schema: 1, clients: [{ id: 'test', publicKey: clientKey, address4: '10.88.0.2',
    address6: 'fd88::2', networkGroup: 'guest', ipv4Enabled: true, ipv6Enabled: true,
    geoPolicy: { mode: 'off', countries: [] } }] };
  const runtimeDirectory = '/tmp/cell-runtime';
  const geoDatabase = async () => ({ RU: { ipv4: ['198.51.100.2/32'], ipv6: ['fd99::2/128'] } });
  const adapter = new CellRuntimeAdapter({ server, runtimeDirectory,
    stateDirectory: runtimeDirectory, geoDatabase });
  await adapter.apply(settings);
  assert.equal(run('awg', ['show', server.interfaceName, 'peers']), clientKey);
  assert.throws(() => run('nft', ['list', 'table', 'inet', 'awg_easy_3_cell_guard']));
  console.log('PASS real AWG start and headless firewall');

  const clientConfig = renderClientConfig({ privateKey: clientPrivate, addresses: ['10.88.0.2/32', 'fd88::2/128'],
    dnsPolicy: { servers: ['192.0.2.1'] }, profile: server.profile, serverPublicKey: run('awg', ['pubkey'], privateKey + '\n'),
    allowedIps: ['198.51.100.2/32', 'fd99::2/128'], endpointHost: '192.0.2.1', endpointPort: 54321 });
  await fs.writeFile('/tmp/client.conf', clientConfig.split('\n').filter(line => !/^(Address|DNS|MTU)\s*=/.test(line)).join('\n'), { mode: 0o600 });
  ns('clientlab', 'amneziawg-go', ['awgprobe']);
  ns('clientlab', 'awg', ['setconf', 'awgprobe', '/tmp/client.conf']);
  for (const args of [['addr', 'add', '10.88.0.2/32', 'dev', 'awgprobe'],
    ['-6', 'addr', 'add', 'fd88::2/128', 'dev', 'awgprobe', 'nodad'], ['link', 'set', 'awgprobe', 'up'],
    ['route', 'add', '198.51.100.2/32', 'dev', 'awgprobe'], ['-6', 'route', 'add', 'fd99::2/128', 'dev', 'awgprobe']]) ns('clientlab', 'ip', args);
  run('ping', ['-c', '1', '-W', '2', '198.51.100.2']);
  const ping = (family, allowed) => {
    let succeeded = false;
    try { ns('clientlab', family === 4 ? 'ping' : 'ping6', ['-c', allowed ? '3' : '1', '-W', '2', family === 4 ? '198.51.100.2' : 'fd99::2']); succeeded = true; }
    catch (error) { if (allowed) {
      console.error(String(error.stdout || '') + String(error.stderr || error.message));
      console.error('server handshake:', run('awg', ['show', server.interfaceName, 'latest-handshakes']).split('\t').at(-1));
      console.error('client handshake:', ns('clientlab', 'awg', ['show', 'awgprobe', 'latest-handshakes']).split('\t').at(-1));
      console.error('client route:', ns('clientlab', 'ip', ['route', 'get', '198.51.100.2']));
      console.error('server return:', run('ip', ['route', 'get', '10.88.0.2']));
      console.error('forwarding:', run('sysctl', ['net.ipv4.ip_forward']));
      console.error('policy:', run('nft', ['list', 'table', 'inet', 'awg_easy_3']));
    } }
    assert.equal(succeeded, allowed, `IPv${family} expected ${allowed ? 'allow' : 'block'}`);
  };
  ping(4, true); ping(6, true);
  const restricted = structuredClone(settings);
  restricted.clients[0].ipv4Enabled = false;
  await adapter.apply(restricted);
  ping(4, false); ping(6, true);
  restricted.clients[0].ipv4Enabled = true;
  restricted.clients[0].geoPolicy = { mode: 'block', countries: ['RU'] };
  await adapter.apply(restricted);
  ping(4, false); ping(6, false);
  await adapter.apply(settings);
  ping(4, true); ping(6, true);
  console.log('PASS real IPv4/IPv6 forwarding, family restriction, GeoIP block and recovery');

  const before = await fs.readFile(`${runtimeDirectory}/${server.interfaceName}.conf`, 'utf8');
  let injected = false;
  const runner = async (file, args, options) => {
    if (!injected && file === 'nft' && args[0] === '-f' && args[1].endsWith('rules.batch.nft')) {
      injected = true;
      throw new Error('injected nft apply failure');
    }
    return runProcess(file, args, options);
  };
  const failureAdapter = new CellRuntimeAdapter({ server, runner, runtimeDirectory,
    stateDirectory: runtimeDirectory });
  await assert.rejects(failureAdapter.apply({ schema: 1, clients: [] }), /injected/);
  assert.equal(run('awg', ['show', server.interfaceName, 'peers']), clientKey);
  assert.equal(await fs.readFile(`${runtimeDirectory}/${server.interfaceName}.conf`, 'utf8'), before);
  assert.match(run('nft', ['list', 'table', 'inet', 'awg_easy_3_cell_guard']), /drop/);
  console.log('PASS real syncconf rollback, previous file preserved, failure guard retained');
  await adapter.apply(settings);
  assert.throws(() => run('nft', ['list', 'table', 'inet', 'awg_easy_3_cell_guard']));
  await adapter.apply({ schema: 1, clients: [] });
  assert.equal(run('awg', ['show', server.interfaceName, 'peers']), '');
  console.log('PASS retry and peer removal');
  await new RuntimeApplier({ runtimeDirectory }).down({ interfaceName: server.interfaceName });
  assert.match(run('nft', ['list', 'table', 'inet', 'unrelated_test']), /chain keep/);
  console.log('PASS stop preserves unrelated firewall table');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
