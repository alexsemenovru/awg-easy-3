'use strict';
// Disposable namespace-only test. No host network, VPS or browser access.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync, spawn } = require('node:child_process');
const { compileCellRouting } = require('../src/lib/CellRoutingPolicy');
const { CellRouteTransaction } = require('../src/lib/CellRouteTransaction');
const { routingGuardSnapshot, planNftReplacement } = require('../src/lib/CellNftOwnership');
const { generateOfficialProfile, renderInterfaceFields } = require('../src/lib/Awg3Config');
const run = (file, args, input) => execFileSync(file, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const ns = (name, file, args, input) => run('ip', ['netns', 'exec', name, file, ...args], input);
const ip = (name, args) => ns(name, 'ip', args);
const key = n => Buffer.alloc(32, n).toString('base64');
const topology = { version: 1,
  nodes: [{ id: 'entry', role: 'cell', ipv4: true, ipv6: true }, { id: 'exit', role: 'controller', ipv4: true, ipv6: true }],
  links: [{ a: 'entry', b: 'exit', ipv4: true, ipv6: true }],
  clients: [['phone', 'entry', 2], ['desktop', 'exit', 3]].map(([id, entry, n]) => ({ entry, exit: 'exit',
    assignment: { id, publicKey: key(n), address4: `10.88.0.${n}`, address6: `fd88::${n}`,
      networkGroup: 'home', ipv4Enabled: true, ipv6Enabled: true, geoPolicy: { mode: 'off', countries: [] } } })) };
const context = peer => ({ clientInterface: 'clients', wanInterface: 'wan', nat66: true,
  links: { [peer]: { interfaceName: peer === 'exit' ? 'transitE' : 'transitX', table: 52000, priority: 20000 } },
  panel: { address4: '10.88.0.1', address6: 'fd88::1', port: 51821 } });
const geoDatabase = { RU: { ipv4: ['198.51.100.10/32'], ipv6: ['fd99::10/128'] } };
async function main() {
  assert.equal(process.env.AWG_CELL_ISOLATED_TEST, '1');
  // Wrapper verifies isolation before mounting the private /proc. Inside the
  // new PID namespace /proc/1 intentionally belongs to the same test network.
  for (const name of ['entry', 'exit', 'phone', 'desktop', 'internet']) {
    run('ip', ['netns', 'add', name]); ip(name, ['link', 'set', 'lo', 'up']);
  }
  function wire(a, ai, a4, a6, b, bi, b4, b6, index) {
    run('ip', ['link', 'add', `a${index}`, 'type', 'veth', 'peer', 'name', `b${index}`]);
    run('ip', ['link', 'set', `a${index}`, 'netns', a]); run('ip', ['link', 'set', `b${index}`, 'netns', b]);
    for (const [name, old, dev, address4, address6] of [[a, `a${index}`, ai, a4, a6], [b, `b${index}`, bi, b4, b6]]) {
      ip(name, ['link', 'set', old, 'name', dev]); ip(name, ['link', 'set', dev, 'up']);
      ip(name, ['addr', 'add', address4, 'dev', dev]); ip(name, ['-6', 'addr', 'add', address6, 'dev', dev, 'nodad']);
    }
    // The client-facing veth emulates already-decrypted AWG traffic. AWG has no
    // neighbor discovery, so install permanent veth neighbors for this fixture.
    for (const [name, dev, other, otherDev, address] of [[a, ai, b, bi, b6], [b, bi, a, ai, a6]]) {
      const mac = JSON.parse(ip(other, ['-j', 'link', 'show', 'dev', otherDev]))[0].address;
      ip(name, ['-6', 'neigh', 'replace', address.split('/')[0], 'lladdr', mac, 'nud', 'permanent', 'dev', dev]);
    }
  }
  wire('entry', 'clients', '10.88.0.254/24', 'fd88::fe/64', 'phone', 'eth', '10.88.0.2/32', 'fd88::2/128', 1);
  wire('exit', 'clients', '10.88.0.253/24', 'fd88::fd/64', 'desktop', 'eth', '10.88.0.3/32', 'fd88::3/128', 2);
  wire('entry', 'underlay', '172.30.0.1/30', 'fd30::1/64', 'exit', 'underlay', '172.30.0.2/30', 'fd30::2/64', 3);
  wire('entry', 'wan', '172.31.1.2/24', 'fd31:1::2/64', 'internet', 'e', '172.31.1.1/24', 'fd31:1::1/64', 4);
  wire('exit', 'wan', '172.31.2.2/24', 'fd31:2::2/64', 'internet', 'x', '172.31.2.1/24', 'fd31:2::1/64', 5);
  for (const [name, gateway4, gateway6, dev] of [['phone', '10.88.0.254', 'fd88::fe', 'eth'],
    ['desktop', '10.88.0.253', 'fd88::fd', 'eth'], ['entry', '172.31.1.1', 'fd31:1::1', 'wan'],
    ['exit', '172.31.2.1', 'fd31:2::1', 'wan']]) {
    ip(name, ['route', 'add', 'default', 'via', gateway4, 'dev', dev, 'onlink']);
    ip(name, ['-6', 'route', 'add', 'default', 'via', gateway6, 'dev', dev, 'onlink']);
  }
  for (const name of ['entry', 'exit']) {
    ns(name, 'sysctl', ['-w', 'net.ipv4.ip_forward=1', 'net.ipv6.conf.all.forwarding=1', 'net.ipv4.conf.all.rp_filter=1']);
    ns(name, 'sysctl', ['-w', 'net.ipv4.conf.clients.rp_filter=2']);
  }
  ip('exit', ['addr', 'add', '10.88.0.1/32', 'dev', 'lo']);
  ip('exit', ['-6', 'addr', 'add', 'fd88::1/128', 'dev', 'lo', 'nodad']);
  ip('internet', ['addr', 'add', '198.51.100.10/32', 'dev', 'lo']);
  ip('internet', ['-6', 'addr', 'add', 'fd99::10/128', 'dev', 'lo', 'nodad']);
  const profile = generateOfficialProfile();
  const keys = { entry: run('awg', ['genkey']), exit: run('awg', ['genkey']) };
  for (const [name, peer, endpoint] of [['entry', 'exit', '172.30.0.2'], ['exit', 'entry', '172.30.0.1']]) {
    const dev = name === 'entry' ? 'transitE' : 'transitX';
    const conf = `[Interface]\nPrivateKey = ${keys[name]}\nListenPort = 54322\n${renderInterfaceFields(profile)}\n\n[Peer]\nPublicKey = ${run('awg', ['pubkey'], keys[peer] + '\n')}\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = ${endpoint}:54322\nPersistentKeepalive = 5\n`;
    await fs.writeFile(`/tmp/${name}-transit.conf`, conf, { mode: 0o600 });
    ns(name, 'amneziawg-go', [dev]); ns(name, 'awg', ['setconf', dev, `/tmp/${name}-transit.conf`]);
    ip(name, ['link', 'set', dev, 'mtu', '1280', 'up']);
    ns(name, 'sysctl', ['-w', `net.ipv4.conf.${dev}.rp_filter=2`]);
  }
  const transactions = new Map();
  const injectedFailures = new Map();
  const guardTable = 'awg_easy_3_routing_guard';
  const guardOwners = new Map(); // Lab coordinator state, not product persistence.
  function changeGuard(name, enabled) {
    const tables = JSON.parse(ns(name, 'nft', ['-j', 'list', 'tables']));
    const present = tables.nftables.some(x => x.table?.name === guardTable && x.table.family === 'inet');
    const current = present ? JSON.parse(ns(name, 'nft', ['-j', 'list', 'table', 'inet', guardTable])) : null;
    const desired = enabled ? routingGuardSnapshot(['clients', name === 'entry' ? 'transitE' : 'transitX']) : null;
    const plan = planNftReplacement({ table: guardTable, current, owned: guardOwners.get(name) || null, desired });
    if (plan.changed) {
      const input = JSON.stringify(plan.batch);
      ns(name, 'nft', ['-c', '-j', '-f', '-'], input);
      ns(name, 'nft', ['-j', '-f', '-'], input);
    }
    guardOwners.set(name, desired);
  }
  for (const name of ['entry', 'exit']) {
    transactions.set(name, new CellRouteTransaction({ journalPath: `/tmp/${name}-routes.json`,
      runner: async (file, args) => {
        if (args[1] === 'route' && args[2] === 'del' && injectedFailures.has(name)) {
          const remaining = injectedFailures.get(name);
          if (remaining === 0) { injectedFailures.delete(name); throw new Error('injected route mutation failure'); }
          injectedFailures.set(name, remaining - 1);
        }
        return { stdout: ns(name, file, args) };
      },
      activateGuard: async () => changeGuard(name, true) }));
  }
  const install = async (initial = false) => {
    for (const [name, peer] of [['entry', 'exit'], ['exit', 'entry']]) {
      const built = compileCellRouting({ topology, nodeId: name, context: context(peer), geoDatabase });
      const policy = (initial ? '' : `delete table inet ${built.table}\n`) + built.nftables;
      ns(name, 'nft', ['-c', '-f', '-'], policy); ns(name, 'nft', ['-f', '-'], policy);
      await transactions.get(name).apply(built.commands);
      changeGuard(name, false);
    }
  };
  await install(true);
  console.log('PASS real nft syntax and route installation for two nodes');
  function ping(family, target, allowed) {
    let success = false;
    try { ns('phone', 'ping', [`-${family}`, '-c', allowed ? '3' : '1', '-W', '2', target]); success = true; }
    catch (e) { if (allowed) console.error(String(e.stdout || '') + String(e.stderr || '')); }
    assert.equal(success, allowed, `IPv${family} ${target} expected ${allowed}`);
  }
  const internet = allowed => { ping(4, '198.51.100.10', allowed); ping(6, 'fd99::10', allowed); };
  internet(true); ping(4, '10.88.0.3', true); ping(6, 'fd88::3', true);
  console.log('PASS AWG remote exit IPv4/IPv6 and cross-server Home');
  const panel = spawn('ip', ['netns', 'exec', 'exit', 'node', '-e',
    'require("http").createServer((q,s)=>s.end("panel-ok")).listen(51821,"::",()=>console.log("ready"))'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Panel fixture timeout')), 5000);
    panel.stdout.once('data', () => { clearTimeout(timer); resolve(); }); panel.once('error', reject);
  });
  const http = (host, allowed) => {
    let success = false;
    try {
      ns('phone', 'node', ['-e', `const h=require('http'); const q=h.get('http://${host}:51821',r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:1))});q.setTimeout(2000,()=>q.destroy());q.on('error',()=>process.exit(1))`]); success = true;
    } catch {}
    assert.equal(success, allowed, 'Panel access ' + host);
  };
  http('10.88.0.1', true); http('[fd88::1]', true);
  topology.clients[0].assignment.networkGroup = 'guest'; await install();
  ping(4, '10.88.0.3', false); ping(6, 'fd88::3', false); http('10.88.0.1', false); http('[fd88::1]', false); internet(true);
  console.log('PASS Home panel access and Guest isolation without blocking Guest internet');
  topology.clients[0].assignment.ipv4Enabled = false; await install();
  ping(4, '198.51.100.10', false); ping(6, 'fd99::10', true);
  topology.clients[0].assignment.ipv4Enabled = true;
  topology.clients[0].assignment.ipv6Enabled = false; await install();
  ping(4, '198.51.100.10', true); ping(6, 'fd99::10', false);
  topology.clients[0].assignment.ipv6Enabled = true;
  topology.clients[0].assignment.geoPolicy = { mode: 'block', countries: ['RU'] }; await install(); internet(false);
  topology.clients[0].assignment.geoPolicy = { mode: 'off', countries: [] }; await install(); internet(true);
  console.log('PASS family permissions and GeoIP across the remote exit');
  // Real VPS kernels can delete interface routes on administrative link-down.
  // Bringing the interface back up alone is not a topology reconciliation.
  ip('entry', ['link', 'set', 'transitE', 'down']); internet(false);
  ip('entry', ['link', 'set', 'transitE', 'up']);
  await transactions.get('entry').recover();
  changeGuard('entry', false);
  internet(true);
  console.log('PASS link-down blocks traffic; explicit owned-route recovery restores the selected exit');
  injectedFailures.set('entry', 1);
  await assert.rejects(transactions.get('entry').apply([]), /injected route mutation failure/);
  internet(false); // Rollback success alone never removes the topology guard.
  const oldTransaction = transactions.get('entry');
  transactions.set('entry', new CellRouteTransaction({ journalPath: oldTransaction.file,
    runner: oldTransaction.runner, activateGuard: oldTransaction.activateGuard }));
  await transactions.get('entry').recover();
  changeGuard('entry', false); internet(true);
  console.log('PASS real partial route rollback, retained guard and restart from durable journal');
  ip('entry', ['route', 'add', '198.18.0.1/32', 'table', '52000', 'dev', 'transitE', 'proto', 'static']);
  await assert.rejects(transactions.get('entry').recover(), /Cell route ownership/);
  internet(false);
  assert.match(ip('entry', ['route', 'show', 'table', '52000', '198.18.0.1/32']), /proto static/);
  ip('entry', ['route', 'del', '198.18.0.1/32', 'table', '52000', 'dev', 'transitE', 'proto', 'static']);
  await transactions.get('entry').recover();
  changeGuard('entry', false); internet(true);
  console.log('PASS foreign route preserved, conflict fails closed, explicit conflict resolution recovers');
  ip('entry', ['link', 'del', 'transitE']); internet(false);
  // Even deleting the policy selector cannot leak into the working local WAN.
  for (const family of [4, 6]) ip('entry', [`-${family}`, 'rule', 'del', 'pref', '20000']);
  internet(false);
  ns('entry', 'ping', ['-c', '1', '-W', '2', '198.51.100.10']);
  console.log('PASS tunnel loss and missing policy rule fail closed; ordinary VPS WAN still works');
  panel.kill();
}
main().catch(e => {
  console.error(e.message);
  for (const cause of e.errors || []) console.error(cause.message);
  process.exit(1);
});
