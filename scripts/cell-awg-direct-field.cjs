'use strict';
const { parseStateText } = require('../src/lib/PrivateStateText');
// Disposable two-VPS laboratory harness, never a production installer.
// One operator invokes one action at a time under an external host-wide lock.
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { AwgKeyManager } = require('../src/lib/AwgKeyManager');
const { generateOfficialProfile } = require('../src/lib/Awg3Config');
const { ControlIdentityStore } = require('../src/lib/ControlIdentityStore');
const { CellAwgBootstrapStore } = require('../src/lib/CellAwgBootstrapStore');
const { CellAwgConnectionStore } = require('../src/lib/CellAwgConnectionStore');
const { CellAwgLifecycle } = require('../src/lib/CellAwgLifecycle');
const { CellAwgTransaction } = require('../src/lib/CellAwgTransaction');
const { CellNftTransaction } = require('../src/lib/CellNftTransaction');
const { CellRouteTransaction } = require('../src/lib/CellRouteTransaction');
const { CellRoutingGuard } = require('../src/lib/CellRoutingGuard');
const { prepareBootstrapDevice } = require('../src/lib/CellAwgBootstrapDevice');
const { CellAwgBootstrapProvisioner } = require('../src/lib/CellAwgBootstrapProvisioner');
const { CellAwgBootstrapCellProvisioner } = require('../src/lib/CellAwgBootstrapCellProvisioner');
const { CellAwgBootstrapRuntime } = require('../src/lib/CellAwgBootstrapRuntime');
const { CellAwgBootstrapCoordinator } = require('../src/lib/CellAwgBootstrapCoordinator');
const { listenAwgRegistrationOnTunnel } = require('../src/lib/CellTunnelRegistrationTransport');

const dir = process.env.CELL_FIELD_STATE;
const action = process.argv[2];
if (!dir || !path.isAbsolute(dir)) throw new Error('Private absolute CELL_FIELD_STATE required');
const endpointHost = process.env.CELL_FIELD_CONTROLLER_PUBLIC;
if (net.isIP(endpointHost) !== 4) throw new Error('CELL_FIELD_CONTROLLER_PUBLIC must be an IPv4 address');
const file = name => path.join(dir, name);
const controllerAddress = '10.90.8.1';
const cellAddress = '10.90.8.2';
const interfaceName = process.env.CELL_FIELD_INTERFACE || 'awgfield8';
if (!/^[A-Za-z0-9_.-]{1,15}$/.test(interfaceName)) throw new Error('Invalid field interface name');
const listenPort = 53081;
const registrationPort = 53082;
const keyManager = new AwgKeyManager();

function components() {
  const bootstrapFile = name => file(process.env.CELL_FIELD_PRODUCT_MAIN === '1'
    ? path.join('bootstrap', name) : name);
  const guard = new CellRoutingGuard({ journalPath: bootstrapFile('guard.json'),
    table: 'awg_easy_3_bootstrap_guard' });
  // Route/nft child transactions pass snapshots, while AWG passes names.
  // This single-interface lab still requires the same durable guard for all.
  const activateGuard = () => guard.protect([interfaceName]);
  return {
    guard,
    lifecycle: new CellAwgLifecycle({ journalPath: bootstrapFile('lifecycle.json'), activateGuard }),
    awg: new CellAwgTransaction({ journalPath: bootstrapFile('awg.json'), activateGuard }),
    firewall: new CellNftTransaction({ journalPath: bootstrapFile('firewall.json'),
      activateGuard, table: 'awg_easy_3_bootstrap' }),
    routes: new CellRouteTransaction({ journalPath: bootstrapFile('routes.json'), activateGuard }),
  };
}

async function loadConfig() { return parseStateText(await fs.readFile(file('config.json'), 'utf8')); }
async function exists(name) {
  try { await fs.access(file(name)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function saveConfig(config) {
  const handle = await fs.open(file('config.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(config)); await handle.sync(); }
  finally { await handle.close(); }
}
async function controller() {
  const parts = components();
  const store = new CellAwgBootstrapStore(file('bootstrap.json'));
  const identityStore = new ControlIdentityStore(file('identity.json'));
  return { ...parts, store, identityStore };
}
async function runtime(parts, config) {
  return new CellAwgBootstrapRuntime({ ...parts, interfaceName,
    privateKey: config.privateKey, listenPort, controllerAddress,
    registrationPort, profile: config.profile,
    verifyPermanent: async () => false });
}
async function main() {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (action === 'controller-init') {
    const parts = await controller();
    const identity = await (await exists('identity.json')
      ? parts.identityStore.load('controller') : parts.identityStore.create('controller'));
    let config;
    if (await exists('config.json')) config = await loadConfig();
    else {
      const keys = await keyManager.generateKeyPair();
      config = { privateKey: keys.privateKey, publicKey: keys.publicKey,
        profile: generateOfficialProfile() };
      await saveConfig(config);
    }
    const provisioner = new CellAwgBootstrapProvisioner({ ...parts, interfaceName,
      controllerAddress, registrationPort });
    if ((await parts.lifecycle.load()).phase === 'empty') {
      const spec = await prepareBootstrapDevice({ interfaceName, listenPort,
        controllerAddress, privateKey: config.privateKey, profile: config.profile });
      await provisioner.initialize(spec);
    } else await provisioner.recover();
    console.log(JSON.stringify({ ready: true, role: 'controller', identityCreated: !!identity }));
    return;
  }
  if (action === 'controller-issue') {
    const parts = await controller(), config = await loadConfig();
    const identity = await parts.identityStore.load('controller');
    const coordinator = new CellAwgBootstrapCoordinator({ store: parts.store,
      runtime: await runtime(parts, config) });
    const code = await coordinator.issue({ controllerKey: identity.publicKey,
      endpointHost, endpointPort: listenPort, registrationPort,
      controllerAddress, cellAddress, serverPublicKey: config.publicKey,
      profile: config.profile, lifetimeMs: 30 * 60 * 1000,
      permanentDescriptor: { version: 1, endpointHost, endpointPort: 53084,
        controllerAddress: '10.91.8.1', cellAddress: '10.91.8.2',
        controlPort: 53083, serverPublicKey: config.publicKey,
        profile: config.profile } });
    const handle = await fs.open(file('invitation'), 'wx', 0o600);
    try { await handle.writeFile(code); await handle.sync(); }
    finally { await handle.close(); }
    console.log(JSON.stringify({ issued: true, storedPrivately: true }));
    return;
  }
  if (action === 'controller-recover') {
    const parts = await controller(), config = await loadConfig();
    const coordinator = new CellAwgBootstrapCoordinator({ store: parts.store,
      runtime: await runtime(parts, config) });
    console.log(JSON.stringify(await coordinator.recover()));
    return;
  }
  if (action === 'controller-listen') {
    const parts = await controller(), config = await loadConfig();
    const server = await listenAwgRegistrationOnTunnel({ address: controllerAddress,
      port: registrationPort, lifecycle: parts.lifecycle,
      identityStore: parts.identityStore, bootstrapStore: parts.store,
      bootstrapRuntime: await runtime(parts, config) });
    console.log(JSON.stringify({ listening: true, transport: 'AWG' }));
    process.on('SIGTERM', () => server.close());
    return;
  }
  if (action === 'controller-status') {
    const parts = await controller();
    const records = (await parts.store.read()).invitations;
    const verified = await (await runtime(parts, await loadConfig())).verifyCurrent();
    console.log(JSON.stringify({ verified, invitations: records.map(x => ({ phase: x.phase,
      status: x.status, permanentBound: !!x.awgPublicKey })) }));
    return;
  }
  if (action === 'cell-begin') {
    const identityStore = new ControlIdentityStore(file('identity.json'));
    await identityStore.create('cell');
    const connection = new CellAwgConnectionStore(file('connection.json'), identityStore);
    await connection.begin(await fs.readFile(file('invitation'), 'utf8'));
    console.log(JSON.stringify({ pending: true }));
    return;
  }
  if (action === 'cell-provision' || action === 'cell-recover') {
    const parts = components();
    const identityStore = new ControlIdentityStore(file('identity.json'));
    const connection = new CellAwgConnectionStore(file('connection.json'), identityStore);
    const provisioner = new CellAwgBootstrapCellProvisioner({ ...parts, connection,
      interfaceName });
    if (action === 'cell-provision') await provisioner.initialize(await fs.readFile(file('invitation'), 'utf8'));
    else await provisioner.recover();
    console.log(JSON.stringify({ ready: true, role: 'cell' }));
    return;
  }
  if (action === 'cell-register') {
    const identityStore = new ControlIdentityStore(file('identity.json'));
    const connection = new CellAwgConnectionStore(file('connection.json'), identityStore);
    console.log(JSON.stringify(await connection.resume()));
    return;
  }
  if (action === 'cell-status') {
    const parts = components();
    const identityStore = new ControlIdentityStore(file('identity.json'));
    const connection = new CellAwgConnectionStore(file('connection.json'), identityStore);
    const state = await connection.read();
    console.log(JSON.stringify({ connection: state?.status || null,
      lifecycle: (await parts.lifecycle.load()).phase,
      guard: (await parts.guard.load()).interfaces }));
    return;
  }
  throw new Error('Unknown field action');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
