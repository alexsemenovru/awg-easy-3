'use strict';

// Requires Linux Docker and /dev/net/tun. All networking stays in disposable
// container namespaces; no host networking, published ports or host sysctls.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const candidate = process.argv[2] || 'awg-easy-3:test';
const previous = 'ghcr.io/alexsemenovru/awg-easy-3@sha256:823c384729b70c565609556697534af2dbd53cab10dff55a7309c541bfd30568';
const prefix = `awg-test-${crypto.randomBytes(6).toString('hex')}`;
const network = `${prefix}-net`, volume = `${prefix}-data`;
const helper = path.resolve(__dirname, 'test-awg-container.cjs');
const containers = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const execute = (name, ...args) => {
  const result = docker('exec', name, 'node', '/test.cjs', ...args);
  if (result) console.log(result);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function reconnect(name) {
  // The running client still holds the previous server's ephemeral session.
  // Permit normal handshake/key timers, but never restart or reconfigure it.
  const started = Date.now();
  for (let attempt = 0; attempt < 14; attempt++) {
    try {
      execute(name, 'traffic', '10.8.0.1', '51821', 'allow');
      console.log(`Existing client reconnected automatically after ${Math.ceil((Date.now() - started) / 1000)} seconds.`);
      return;
    } catch (error) {
      if (!String(error.stderr).includes('test timeout')) throw error;
      await wait(1000);
    }
  }
  throw new Error('Existing client did not reconnect within three minutes');
}
async function ready(name, server = false) {
  for (let attempt = 0; attempt < 35; attempt++) {
    try {
      if (server) docker('exec', name, 'node', '-e', "fetch('http://10.8.0.1:51821/api/v1/session').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))");
      else if (!docker('logs', name).includes('Test client ready.')) throw new Error('starting');
      return;
    } catch { await wait(1000); }
  }
  throw new Error(`Container ${name} failed readiness: ${docker('logs', name)}`);
}
function start(name, image, args, extra = []) {
  containers.push(name);
  return docker('run', '-d', '--name', name, '--network', network, '--cap-add', 'NET_ADMIN',
    '--device', '/dev/net/tun', '--sysctl', 'net.ipv6.conf.all.disable_ipv6=0',
    '--sysctl', 'net.ipv4.ip_forward=1', '--sysctl', 'net.ipv6.conf.all.forwarding=1',
    '-v', `${volume}:/data`, '-v', `${helper}:/test.cjs:ro`, '-e', 'AWG_PANEL_PORT=51821',
    ...extra, image, ...args);
}
async function main() {
  docker('pull', previous);
  // Explicit IPAM permits retaining the server endpoint across replacement.
  // Docker rejects overlap with existing networks; never modify those networks.
  let created = false;
  for (let attempt = 0; attempt < 20 && !created; attempt++) {
    try {
      docker('network', 'create', '--subnet', `172.30.${crypto.randomInt(0, 256)}.0/24`, network);
      created = true;
    } catch (error) {
      if (!String(error.stderr).includes('Pool overlaps')) throw error;
    }
  }
  if (!created) throw new Error('No non-overlapping disposable test subnet found');
  docker('volume', 'create', volume);
  const server = `${prefix}-server`, probe = `${prefix}-probe`, guest = `${prefix}-guest`;
  start(server, previous, ['-e', 'setInterval(()=>{},1000)'], ['--entrypoint', 'node']);
  const ip = JSON.parse(docker('inspect', server))[0].NetworkSettings.Networks[network].IPAddress;
  execute(server, 'fixture', ip);
  docker('rm', '-f', server);
  start(server, previous, ['serve'], ['--ip', ip]);
  await ready(server, true);
  for (const [name, id] of [[probe, 'probe'], [guest, 'guest']]) {
    start(name, previous, ['/test.cjs', 'client', id], ['--entrypoint', 'node']);
    await ready(name);
  }
  const check = (name, host, port, expected, size) => execute(name, 'traffic', host, String(port), expected, String(size || 65536));
  check(probe, '10.8.0.1', 51821, 'allow');
  check(probe, 'fd42:8:3::1', 51821, 'allow');
  execute(probe, 'panel-links');
  execute(server, 'snapshot');
  // Replace only the server image; clients retain their old engine and profile.
  docker('stop', '-t', '15', server); docker('rm', server);
  start(server, candidate, ['serve'], ['--ip', ip]);
  await ready(server, true);
  execute(server, 'snapshot');
  await reconnect(probe);
  execute(probe, 'panel-links');
  docker('exec', '-d', server, 'node', '/test.cjs', 'echo');
  await wait(1000);
  for (const host of ['10.8.0.1', 'fd42:8:3::1']) {
    check(probe, host, 51821, 'allow');
    check(probe, host, 8080, 'allow', 2 * 1024 * 1024);
    check(guest, host, 51821, 'block');
  }
  for (const [v4, v6] of [['on', 'off'], ['off', 'on'], ['off', 'off'], ['on', 'on']]) {
    execute(server, 'permissions', v4, v6);
    if (v4 === 'on' && v6 === 'on') await reconnect(probe);
    for (const [clientHost, serverHost, enabled] of [['10.8.0.3', '10.8.0.1', v4], ['fd42:8:3::3', 'fd42:8:3::1', v6]]) {
      check(probe, serverHost, 8080, enabled === 'on' ? 'allow' : 'block');
      check(server, clientHost, 8080, enabled === 'on' ? 'allow' : 'block');
    }
  }
  execute(server, 'snapshot');
  docker('stop', '-t', '15', server); docker('rm', server);
  start(server, previous, ['serve'], ['--ip', ip]);
  await ready(server, true);
  execute(server, 'snapshot');
  await reconnect(probe);
  check(probe, '10.8.0.1', 51821, 'allow');
  check(probe, 'fd42:8:3::1', 51821, 'allow');
  console.log('PASS old-client interoperability, server image upgrade/rollback, unchanged exports and dual-stack permissions.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  for (const name of [...new Set(containers)].reverse()) { try { docker('rm', '-f', name); } catch {} }
  try { docker('volume', 'rm', volume); } catch {}
  try { docker('network', 'rm', network); } catch {}
});
