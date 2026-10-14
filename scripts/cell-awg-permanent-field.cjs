'use strict';
// Disposable AWG-control-path field harness. Does not configure user traffic.
// External per-host flock is required for mutating actions.
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { generateOfficialProfile, renderInterfaceFields } = require('../src/lib/Awg3Config');
const { normalizeAwgConfig, matchesAwgConfig } = require('../src/lib/CellAwgSnapshot');
const { createAwgOwnership } = require('../src/lib/CellAwgOwnership');
const { CellAwgLifecycle } = require('../src/lib/CellAwgLifecycle');
const { CellAwgTransaction } = require('../src/lib/CellAwgTransaction');
const { CellNftTransaction } = require('../src/lib/CellNftTransaction');
const { CellRouteTransaction } = require('../src/lib/CellRouteTransaction');
const { CellRoutingGuard } = require('../src/lib/CellRoutingGuard');
const { normalizeNftSnapshot } = require('../src/lib/CellNftOwnership');
const { ruleExpressions } = require('../src/lib/CellNftPolicyJson');
const { bootstrapServerRoutes, bootstrapCellRoutes } = require('../src/lib/CellAwgBootstrapRoutes');
const { ControlIdentityStore } = require('../src/lib/ControlIdentityStore');
const { CellAwgBootstrapStore } = require('../src/lib/CellAwgBootstrapStore');
const { CellAwgConnectionStore } = require('../src/lib/CellAwgConnectionStore');
const { decodeAwgBootstrapInvitation } = require('../src/lib/CellAwgBootstrapInvitation');
const { CellAwgBootstrapRuntime } = require('../src/lib/CellAwgBootstrapRuntime');
const { CellAwgBootstrapCoordinator } = require('../src/lib/CellAwgBootstrapCoordinator');
const { CellAwgBootstrapCellRetirement } = require('../src/lib/CellAwgBootstrapCellRetirement');
const { CellSettingsPublisher } = require('../src/lib/CellSettingsPublisher');
const { CellSettingsReceiver } = require('../src/lib/CellSettingsReceiver');
const { listenTunnelControlEndpoint, syncCellSettings } = require('../src/lib/CellControlService');
const { openCellPermanentJoinHost } = require('../src/lib/CellPermanentJoinHost');
const { CellAwgPermanentDeployment } = require('../src/lib/CellAwgPermanentDeployment');
const { CellAwgPermanentRetirementGate } = require('../src/lib/CellAwgPermanentRetirementGate');
const { joinPermanentController } = require('../src/lib/CellAwgPermanentJoin');

const dir = process.env.CELL_FIELD_STATE;
const role = process.env.CELL_FIELD_ROLE;
const action = process.argv[2];
if (!dir || !path.isAbsolute(dir) || !['controller', 'cell'].includes(role)) {
  throw new Error('Private CELL_FIELD_STATE and CELL_FIELD_ROLE required');
}
const mainPublic = process.env.CELL_FIELD_CONTROLLER_PUBLIC;
if (net.isIP(mainPublic) !== 4) throw new Error('CELL_FIELD_CONTROLLER_PUBLIC must be an IPv4 address');
const file = name => path.join(dir, name);
const permName = process.env.CELL_FIELD_PERMANENT_INTERFACE || 'awgperm8';
const tempName = process.env.CELL_FIELD_INTERFACE || 'awgfield8';
if (![permName, tempName].every(name => /^[A-Za-z0-9_.-]{1,15}$/.test(name))
  || permName === tempName) throw new Error('Invalid field interface names');
const mainAddress = '10.91.8.1', cellAddress = '10.91.8.2';
const udpPort = 53084, controlPort = 53083;
const table = 'awg_easy_3_routes';

function parts(prefix = 'perm-', name = permName, guardTable = 'awg_easy_3_routing_guard',
  policyTable = table) {
  const guard = new CellRoutingGuard({ journalPath: file(prefix + 'guard.json'), table: guardTable });
  const activateGuard = () => guard.protect([name]);
  return { guard,
    lifecycle: new CellAwgLifecycle({ journalPath: file(prefix + 'lifecycle.json'), activateGuard }),
    awg: new CellAwgTransaction({ journalPath: file(prefix + 'awg.json'), activateGuard }),
    routes: new CellRouteTransaction({ journalPath: file(prefix + 'routes.json'), activateGuard }),
    firewall: new CellNftTransaction({ journalPath: file(prefix + 'firewall.json'),
      activateGuard, table: policyTable }),
  };
}
function bootstrapParts() {
  const guard = new CellRoutingGuard({ journalPath: file('guard.json'),
    table: 'awg_easy_3_bootstrap_guard' });
  const activateGuard = () => guard.protect([tempName]);
  return { guard,
    lifecycle: new CellAwgLifecycle({ journalPath: file('lifecycle.json'), activateGuard }),
    awg: new CellAwgTransaction({ journalPath: file('awg.json'), activateGuard }),
    routes: new CellRouteTransaction({ journalPath: file('routes.json'), activateGuard }),
    firewall: new CellNftTransaction({ journalPath: file('firewall.json'),
      activateGuard, table: 'awg_easy_3_bootstrap' }),
  };
}
const identities = () => new ControlIdentityStore(file('identity.json'));
const enrollment = () => new CellAwgBootstrapStore(file('bootstrap.json'));
const connection = () => new CellAwgConnectionStore(file('connection.json'), identities());
async function invite() { return decodeAwgBootstrapInvitation(await fs.readFile(file('invitation'), 'utf8'), 0); }
async function enrolled() {
  const records = (await enrollment().read()).invitations.filter(x => x.status === 'consumed');
  if (records.length !== 1 || !records[0].awgPublicKey || !records[0].awgPresharedKey) {
    throw new Error('Exactly one registered AWG cell required');
  }
  return records[0];
}
async function desiredConfig() {
  if (role === 'controller') {
    const config = JSON.parse(await fs.readFile(file('config.json'), 'utf8'));
    const peer = await enrolled();
    const text = `[Interface]\nPrivateKey = ${config.privateKey}\nListenPort = ${udpPort}\n${renderInterfaceFields(config.profile)}\n`
      + `\n[Peer]\nPublicKey = ${peer.awgPublicKey}\nPresharedKey = ${peer.awgPresharedKey}\nAllowedIPs = ${cellAddress}/32\n`;
    normalizeAwgConfig(text);
    return text;
  }
  const saved = await connection().read();
  if (saved?.status !== 'registered') throw new Error('Registered cell required');
  const invitation = await invite();
  const text = `[Interface]\nPrivateKey = ${saved.permanent.privateKey}\n${renderInterfaceFields(invitation.profile)}\n`
    + `\n[Peer]\nPublicKey = ${invitation.serverPublicKey}\nPresharedKey = ${saved.permanent.presharedKey}\n`
    + `AllowedIPs = ${mainAddress}/32\nEndpoint = ${mainPublic}:${udpPort}\nPersistentKeepalive = 5\n`;
  normalizeAwgConfig(text);
  return text;
}
function policy() {
  const nftables = [{ table: { family: 'inet', name: table } }];
  for (const hook of ['input', 'output', 'forward']) nftables.push({ chain: {
    family: 'inet', table, name: hook, type: 'filter', hook, prio: -15, policy: 'accept',
  } });
  const add = (chain, line) => nftables.push({ rule: { family: 'inet', table, chain,
    ...ruleExpressions(line) } });
  if (role === 'controller') {
    add('input', `iifname "${permName}" ip saddr ${cellAddress} ip daddr ${mainAddress} tcp dport ${controlPort} accept`);
    add('input', `iifname "${permName}" drop`);
    add('output', `oifname "${permName}" ip saddr ${mainAddress} ip daddr ${cellAddress} tcp sport ${controlPort} accept`);
    add('output', `ip daddr ${cellAddress} drop`);
    add('output', `oifname "${permName}" drop`);
  } else {
    add('input', `iifname "${permName}" ip saddr ${mainAddress} ip daddr ${cellAddress} tcp sport ${controlPort} accept`);
    add('input', `iifname "${permName}" drop`);
    add('output', `oifname "${permName}" ip saddr ${cellAddress} ip daddr ${mainAddress} tcp dport ${controlPort} accept`);
    add('output', `ip daddr ${mainAddress} drop`);
    add('output', `oifname "${permName}" drop`);
  }
  add('forward', `iifname "${permName}" drop`);
  add('forward', `oifname "${permName}" drop`);
  const ordered = [nftables[0]];
  for (const hook of ['input', 'output', 'forward']) {
    ordered.push(...nftables.filter(item => item.chain?.name === hook));
    ordered.push(...nftables.filter(item => item.rule?.chain === hook));
  }
  return normalizeNftSnapshot({ nftables: ordered }, table);
}
function desiredRoutes() {
  return role === 'controller' ? bootstrapServerRoutes({ interfaceName: permName,
    controllerAddress: mainAddress, peers: [{ phase: 'ready', cellAddress }] })
    : bootstrapCellRoutes({ interfaceName: permName, cellAddress,
      controllerAddress: mainAddress });
}
async function pathReady(parts, peerKey) {
  const state = await parts.lifecycle.load();
  if (state.phase !== 'ready' || !(await parts.lifecycle.verify(state.spec)).up) return false;
  if ((await parts.guard.load()).interfaces.length || await parts.guard.current() !== null) return false;
  if (!(await parts.firewall.equal(await parts.firewall.current(), policy()))) return false;
  const route = await parts.routes.load();
  if (route.pending || JSON.stringify(route.committed) !== JSON.stringify(desiredRoutes())) return false;
  const lines = execFileSync('awg', ['show', permName, 'latest-handshakes'], { encoding: 'utf8' }).trim().split('\n');
  const timestamp = Number(lines.find(line => line.startsWith(peerKey + '\t'))?.split('\t')[1] || 0);
  return timestamp > 0 && Date.now() / 1000 - timestamp < 120;
}
async function publishForCell(cellKey) { return new CellSettingsPublisher(file('desired.json'), identities(), cellKey); }
async function main() {
  const permanent = parts();
  if (action === 'product-controller-join' && role === 'controller') {
    const deployment = new CellAwgPermanentDeployment({ stateDirectory: file('permanent') });
    const gate = new CellAwgPermanentRetirementGate({ deployment });
    const temporary = bootstrapParts();
    const config = JSON.parse(await fs.readFile(file('config.json'), 'utf8'));
    const runtime = new CellAwgBootstrapRuntime({ ...temporary, store: enrollment(),
      interfaceName: tempName, privateKey: config.privateKey, listenPort: 53081,
      controllerAddress: '10.90.8.1', registrationPort: 53082,
      profile: config.profile, verifyPermanent: item => gate.verifyController(item) });
    const coordinator = new CellAwgBootstrapCoordinator({ store: runtime.store, runtime });
    console.log(JSON.stringify(await joinPermanentController({ bootstrapStore: enrollment(),
      invitationId: (await enrolled()).id, deployment, gate, coordinator,
      interfaceName: permName, privateKey: config.privateKey })));
    return;
  }
  if (action === 'product-controller-status' && role === 'controller') {
    const deployment = new CellAwgPermanentDeployment({ stateDirectory: file('permanent') });
    const gate = new CellAwgPermanentRetirementGate({ deployment });
    const record = await enrolled();
    console.log(JSON.stringify({ permanentReady: await gate.verifyController(record),
      bootstrapPhase: record.phase }));
    return;
  }
  if (action === 'product-join' && role === 'cell') {
    const host = openCellPermanentJoinHost({ stateDirectory: dir,
      interfaceName: permName, temporaryInterfaceName: tempName,
      connectionStore: connection(), bootstrap: bootstrapParts() });
    console.log(JSON.stringify(await host.join()));
    return;
  }
  if (action === 'product-status' && role === 'cell') {
    const deployment = new CellAwgPermanentDeployment({ stateDirectory: file('permanent') });
    const gate = new CellAwgPermanentRetirementGate({ deployment });
    console.log(JSON.stringify({ permanentReady: await gate.verifyCell(await connection().read()),
      temporaryRetired: (await bootstrapParts().lifecycle.load()).phase === 'empty' }));
    return;
  }
  if (action === 'permanent-init') {
    const config = await desiredConfig();
    const saved = await permanent.lifecycle.load();
    if (saved.phase !== 'empty') throw new Error('Permanent path already has a lifecycle; inspect before recovery');
    const spec = { version: 1, owner: createAwgOwnership({ interfaceName: permName,
      config }), addresses: [`${role === 'controller' ? mainAddress : cellAddress}/32`] };
    await permanent.lifecycle.create(spec);
    await permanent.awg.initialize(spec.owner);
    await permanent.routes.apply(desiredRoutes());
    await permanent.firewall.apply(policy());
    await permanent.guard.release(async () => {
      const current = await permanent.lifecycle.load();
      return current.phase === 'ready' && (await permanent.lifecycle.verify(current.spec)).up
        && (await permanent.awg.load()).pending === null
        && JSON.stringify((await permanent.routes.load()).committed) === JSON.stringify(desiredRoutes())
        && permanent.firewall.equal(await permanent.firewall.current(), policy());
    });
    console.log(JSON.stringify({ permanentReady: true, role }));
    return;
  }
  if (action === 'permanent-update-policy') {
    const saved = await permanent.lifecycle.load();
    if (saved.phase !== 'ready' || !(await permanent.lifecycle.verify(saved.spec)).up) {
      throw new Error('Owned permanent AWG path required');
    }
    await permanent.guard.protect([permName]);
    await permanent.firewall.apply(policy());
    await permanent.guard.release(async () => {
      const current = await permanent.lifecycle.load();
      return current.phase === 'ready' && (await permanent.lifecycle.verify(current.spec)).up
        && permanent.firewall.equal(await permanent.firewall.current(), policy())
        && JSON.stringify((await permanent.routes.load()).committed) === JSON.stringify(desiredRoutes());
    });
    console.log(JSON.stringify({ policyUpdated: true }));
    return;
  }
  if (action === 'permanent-recover') {
    await permanent.guard.protect([permName]);
    await permanent.lifecycle.recover();
    await permanent.awg.recover();
    await permanent.routes.recover();
    await permanent.firewall.recover();
    await permanent.guard.release(async () => {
      const current = await permanent.lifecycle.load();
      return current.phase === 'ready' && (await permanent.lifecycle.verify(current.spec)).up
        && permanent.firewall.equal(await permanent.firewall.current(), policy())
        && JSON.stringify((await permanent.routes.load()).committed) === JSON.stringify(desiredRoutes());
    });
    console.log(JSON.stringify({ permanentRecovered: true, role }));
    return;
  }
  if (action === 'control-listen' && role === 'controller') {
    const deployment = new CellAwgPermanentDeployment({ stateDirectory: file('permanent') });
    const plan = await deployment.store.read();
    const lifecycle = plan
      ? deployment.buildPath({ stateDirectory: deployment.stateDirectory, plan }).lifecycle
      : permanent.lifecycle;
    const listener = await listenTunnelControlEndpoint({ address: mainAddress, port: controlPort,
      identityStore: identities(), bootstrapStore: enrollment(),
      lifecycle, publisherForCell: key =>
        new CellSettingsPublisher(file('desired.json'), identities(), key) });
    console.log(JSON.stringify({ controlListening: true, transport: 'AWG' }));
    process.on('SIGTERM', () => listener.close());
    return;
  }
  if (action === 'controller-close' && role === 'controller') {
    const record = await enrolled();
    if (!await pathReady(permanent, record.awgPublicKey)) throw new Error('Permanent path not verified');
    const temporary = bootstrapParts();
    const config = JSON.parse(await fs.readFile(file('config.json'), 'utf8'));
    const runtime = new CellAwgBootstrapRuntime({ ...temporary, store: enrollment(),
      interfaceName: tempName, privateKey: config.privateKey, listenPort: 53081,
      controllerAddress: '10.90.8.1', registrationPort: 53082,
      profile: config.profile, verifyPermanent: item => pathReady(permanent, item.awgPublicKey) });
    const result = await new CellAwgBootstrapCoordinator({ store: runtime.store,
      runtime }).close(record.id);
    console.log(JSON.stringify(result));
    return;
  }
  if (action === 'cell-retire' && role === 'cell') {
    const temporary = bootstrapParts();
    const invitation = await invite();
    const result = await new CellAwgBootstrapCellRetirement({ ...temporary,
      connection: connection(), interfaceName: tempName,
      verifyPermanent: () => pathReady(permanent, invitation.serverPublicKey) }).retire();
    console.log(JSON.stringify(result));
    return;
  }
  if (action === 'publish' && role === 'controller') {
    const record = await enrolled();
    const publisher = await publishForCell(record.cellKey);
    const desired = await publisher.publish({ schema: 1, clients: [] });
    console.log(JSON.stringify({ revision: desired.revision }));
    return;
  }
  if (action === 'sync' && role === 'cell') {
    const saved = await connection().read();
    const receiver = new CellSettingsReceiver(file('received.json'), {
      controllerKey: saved.controllerKey, cellKey: saved.cellKey,
      apply: async settings => { if (settings.schema !== 1 || settings.clients.length) {
        throw new Error('Field adapter accepts only empty settings');
      } },
    });
    console.log(JSON.stringify(await syncCellSettings({ connectionStore: connection(),
      identityStore: identities(), receiver, host: mainAddress, port: controlPort,
      transport: 'tunnel' })));
    return;
  }
  if (action === 'status') {
    const state = await permanent.lifecycle.load();
    const peerKey = role === 'controller' ? (await enrolled()).awgPublicKey
      : (await invite()).serverPublicKey;
    const info = { role, lifecycle: state.phase, guard: (await permanent.guard.load()).interfaces,
      permanentReady: await pathReady(permanent, peerKey) };
    if (role === 'controller') {
      const publisher = await publishForCell((await enrolled()).cellKey);
      const desired = await publisher.load();
      info.desired = desired?.desired.revision ?? null;
      info.applied = desired?.ack?.revision ?? null;
      info.bootstrapPhase = (await enrolled()).phase;
    } else {
      const receiver = new CellSettingsReceiver(file('received.json'), {
        controllerKey: (await connection().read()).controllerKey,
        cellKey: (await connection().read()).cellKey, apply: async () => {},
      });
      info.applied = (await receiver.load())?.applied?.revision ?? null;
    }
    console.log(JSON.stringify(info));
    return;
  }
  throw new Error('Unknown field action');
}
main().catch(error => { console.error(error.message); process.exitCode = 1 });
