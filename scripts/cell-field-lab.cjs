'use strict';
// Explicit disposable-VPS harness. Not a production installer or public API.
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { ControlIdentityStore } = require('../src/lib/ControlIdentityStore');
const { ControlCertificateStore } = require('../src/lib/ControlCertificateStore');
const { CellEnrollmentStore } = require('../src/lib/CellEnrollmentStore');
const { CellConnectionStore } = require('../src/lib/CellConnectionStore');
const { CellSettingsPublisher } = require('../src/lib/CellSettingsPublisher');
const { CellSettingsReceiver } = require('../src/lib/CellSettingsReceiver');
const { prepareRegistrationEndpoint } = require('../src/lib/CellRegistrationEndpoint');
const { prepareControlEndpoint, syncCellSettings } = require('../src/lib/CellControlService');
const { CellAgent } = require('../src/lib/CellAgent');
const { CellRuntimeAdapter } = require('../src/lib/CellRuntimeAdapter');
const dir = process.env.CELL_LAB_STATE;
const role = process.env.CELL_LAB_ROLE;
const host = process.env.CELL_LAB_MAIN_HOST;
const registrationPort = 39001;
const controlPort = 39002;
const read = file => fs.readFile(file, 'utf8').then(JSON.parse);
const socketPath = () => path.join(dir, 'admin.sock');
async function cli(command, file) {
  const request = { command };
  if (command === 'publish') request.settings = await read(file);
  const response = await new Promise((resolve, reject) => {
    const s = net.connect(socketPath(), () => s.end(JSON.stringify(request) + '\n'));
    let buffer = '';
    s.setTimeout(30000, () => s.destroy(new Error('Admin timeout')));
    s.on('data', data => { buffer += data; if (buffer.length > 1024 * 1024) s.destroy(new Error('Oversize response')); });
    s.on('error', reject);
    s.on('end', () => { try { resolve(JSON.parse(buffer)); } catch (e) { reject(e); } });
  });
  if (!response.ok) throw new Error(response.error);
  if (command === 'invite') {
    if (!file) throw new Error('Invitation output file required');
    await fs.writeFile(file, response.result.code, { flag: 'wx', mode: 0o600 });
    console.log('Invitation saved privately');
  } else console.log(JSON.stringify(response.result));
}
async function serve() {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Exclusive process ownership; stale lock after SIGKILL/reboot requires explicit
  // operator verification/removal. Never automatically steal a live store.
  const lockPath = path.join(dir, 'owner.lock');
  const lock = await fs.open(lockPath, 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  const identities = new ControlIdentityStore(path.join(dir, 'identity.json'));
  let identity;
  try { await fs.access(identities.filePath); identity = await identities.load(role); }
  catch (e) { if (e.code !== 'ENOENT') throw e; identity = await identities.create(role); }
  const servers = [];
  let agent;
  let operate;
  if (role === 'controller') {
    const enrollmentStore = new CellEnrollmentStore(path.join(dir, 'enrollment.json'));
    const certificateStore = new ControlCertificateStore(path.join(dir, 'control.crt'), identities);
    const publisherForCell = key => new CellSettingsPublisher(path.join(dir,
      crypto.createHash('sha256').update(key).digest('hex') + '.desired.json'), identities, key);
    const options = { identityStore: identities, enrollmentStore, certificateStore, publisherForCell };
    for (const [server, port] of [[await prepareRegistrationEndpoint(options), registrationPort],
      [await prepareControlEndpoint(options), controlPort]]) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '::', resolve); });
      servers.push(server);
    }
    operate = async request => {
      if (request.command === 'invite') return { code: await enrollmentStore.create({ host,
        port: registrationPort, controllerKey: identity.publicKey }) };
      const cells = (await enrollmentStore.read()).invitations.filter(x => x.status === 'consumed');
      if (request.command === 'status') return Promise.all(cells.map(async cell => {
        const state = await publisherForCell(cell.cellKey).load();
        return { cellKey: cell.cellKey, desired: state?.desired.revision ?? null, applied: state?.ack?.revision ?? null };
      }));
      if (request.command === 'publish') {
        if (cells.length !== 1) throw new Error('Lab publish requires exactly one enrolled cell');
        return { revision: (await publisherForCell(cells[0].cellKey).publish(request.settings)).revision };
      }
      throw new Error('Unknown lab command');
    };
  } else {
    const connectionStore = new CellConnectionStore(path.join(dir, 'connection.json'), identities);
    if (!await connectionStore.read()) await connectionStore.begin(await fs.readFile(path.join(dir, 'invitation'), 'utf8'));
    await connectionStore.resume();
    const trust = await connectionStore.read();
    const runtimeFile = process.env.CELL_LAB_RUNTIME;
    const adapter = runtimeFile ? new CellRuntimeAdapter({ server: await read(runtimeFile),
      runtimeDirectory: path.join(dir, 'runtime'), stateDirectory: path.join(dir, 'cell-runtime-state'),
      geoDatabase: async () => process.env.CELL_LAB_GEO ? read(process.env.CELL_LAB_GEO) : {} }) : null;
    const receiver = new CellSettingsReceiver(path.join(dir, 'received.json'), {
      ...trust, ...(adapter ? { validate: settings => adapter.validate(settings) } : {}),
      apply: async settings => {
        try { await fs.access(path.join(dir, 'fail-apply')); throw new Error('Injected field-test apply failure'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (adapter) await adapter.apply(settings);
        else await fs.writeFile(path.join(dir, 'simulated-runtime.json'), JSON.stringify(settings), { mode: 0o600 });
      },
    });
    agent = new CellAgent({ restore: () => receiver.restoreApplied(),
      sync: () => syncCellSettings({ connectionStore, identityStore: identities, receiver,
        host, port: controlPort }), intervalMs: 3000, maxBackoffMs: 12000,
      onStatus: value => console.log(JSON.stringify(value)) });
    await agent.start();
    operate = async request => {
      if (request.command !== 'status') throw new Error('Unknown lab command');
      const state = await receiver.load();
      return { ...agent.status, received: state?.received.revision ?? null, applied: state?.applied?.revision ?? null,
        runtime: adapter ? 'awg' : 'simulated' };
    };
  }
  await fs.unlink(socketPath()).catch(e => { if (e.code !== 'ENOENT') throw e; });
  const admin = net.createServer({ allowHalfOpen: true }, s => {
    let data = '';
    s.on('error', () => {});
    s.setTimeout(10000, () => s.destroy());
    s.on('data', chunk => { data += chunk; if (Buffer.byteLength(data) > 300000) s.destroy(); });
    s.on('end', async () => {
      try { s.end(JSON.stringify({ ok: true, result: await operate(JSON.parse(data)) })); }
      catch (e) { s.end(JSON.stringify({ ok: false, error: e.message })); }
    });
  });
  await new Promise((resolve, reject) => { admin.once('error', reject); admin.listen(socketPath(), resolve); });
  await fs.chmod(socketPath(), 0o600);
  servers.push(admin);
  console.log('Cell field lab ready: ' + role);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await agent?.stop();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await lock.close(); await fs.unlink(lockPath);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}
async function main() {
  if (process.env.AWG_CELL_FIELD_LAB !== '1' || !dir || !path.isAbsolute(dir)
    || !['controller', 'cell'].includes(role) || !host) throw new Error('Explicit disposable lab environment required');
  if (process.argv[2] === 'serve') await serve();
  else await cli(process.argv[2], process.argv[3]);
}
// An error during partial listener setup must not leave an orphaned lab daemon.
main().catch(error => { console.error(error.message); process.exit(1); });
