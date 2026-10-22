'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { openCellBootstrapInstallationHost } = require('./CellBootstrapInstallationHost');
const { decodeAwgBootstrapInvitation } = require('./CellAwgBootstrapInvitation');
const { CellUserConfigStore } = require('./CellUserConfigStore');
const { startCellService, syncCellOnce } = require('./CellService');
const { readCellStatus } = require('./CellStatus');
const { ensureCellUserBootstrap } = require('./CellUserBootstrap');
const { validEndpointHost } = require('./CellAwgEndpointHost');

const INTERFACE = /^[a-zA-Z0-9_.-]{1,15}$/;
const PORT = /^\d{1,5}$/;

function configFromEnvironment(env) {
  if (!env || typeof env !== 'object') throw new TypeError('Cell environment required');
  const stateDirectory = env.AWG_CELL_STATE_DIR;
  const invitationFile = env.AWG_CELL_INVITATION_FILE;
  const interfaceName = env.AWG_CELL_BOOTSTRAP_INTERFACE;
  const controlInterface = env.AWG_CELL_CONTROL_INTERFACE;
  const userInterface = env.AWG_CELL_USER_INTERFACE;
  const wanInterface = env.AWG_CELL_WAN_INTERFACE;
  const endpointHost = env.AWG_CELL_ENDPOINT;
  const portText = env.AWG_CELL_USER_PORT;
  const userPort = PORT.test(portText || '') ? Number(portText) : NaN;
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || path.normalize(stateDirectory) !== stateDirectory
    || (invitationFile !== undefined && invitationFile !== path.join(stateDirectory, 'invitation'))
    || [interfaceName, controlInterface, userInterface].some(name => !INTERFACE.test(name || ''))
    || (wanInterface !== undefined && (!INTERFACE.test(wanInterface)
      || [interfaceName, controlInterface, userInterface].includes(wanInterface)))
    || (endpointHost !== undefined && !validEndpointHost(endpointHost))
    || new Set([interfaceName, controlInterface, userInterface]).size !== 3
    || !Number.isInteger(userPort) || userPort < 1 || userPort > 65535) {
    throw new Error('Explicit Cell state path, three distinct interfaces and user UDP port required');
  }
  return { stateDirectory, invitationFile, wanInterface, endpointHost,
    interfaceName, runtimeDirectory: env.AWG_CELL_RUNTIME_DIR, resources: {
    interfaceNames: [interfaceName, controlInterface, userInterface],
    udpPorts: [userPort], nftTables: [
      'awg_easy_3_bootstrap', 'awg_easy_3_bootstrap_guard',
      'awg_easy_3_control', 'awg_easy_3_control_guard',
      'awg_easy_3', 'awg_easy_3_cell_guard',
    ],
  } };
}

async function readInvitation(input) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 8194) throw new Error('Cell invitation is too large');
    chunks.push(data);
  }
  const code = Buffer.concat(chunks).toString('utf8').trim();
  if (!code) throw new Error('Cell invitation required on stdin');
  return code;
}

async function readPrivateInvitationFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 8194
    || (process.platform !== 'win32'
      && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error('Unsafe Cell invitation file');
  }
  const code = (await fs.readFile(file, 'utf8')).trim();
  decodeAwgBootstrapInvitation(code);
  return code;
}

async function runCellBootstrapCli({ args, env, input, output,
  openHost = openCellBootstrapInstallationHost,
  startService = startCellService,
  syncOnce = syncCellOnce,
  statusReader = readCellStatus,
  ensureUser = ensureCellUserBootstrap,
  newUserStore = (...params) => new CellUserConfigStore(...params) } = {}) {
  if (!Array.isArray(args) || args.length !== 1
    || !['begin', 'resume', 'register', 'join', 'configure-user', 'sync', 'serve', 'status'].includes(args[0])) {
    throw new Error('Usage: cell-cli.js begin|resume|register|join|configure-user|sync|serve|status');
  }
  if (!output || typeof output.write !== 'function') throw new TypeError('Cell status output required');
  const config = configFromEnvironment(env);
  if (args[0] === 'status') {
    const status = await statusReader(config);
    const revision = value => value === null || Number.isSafeInteger(value) && value > 0;
    if (!status || !['absent', 'pending', 'registered'].includes(status.registration)
      || typeof status.permanentPlan !== 'boolean'
      || typeof status.userConfigured !== 'boolean'
      || !revision(status.receivedRevision) || !revision(status.appliedRevision)) {
      throw new Error('Invalid read-only Cell status');
    }
    output.write(`${JSON.stringify({ registration: status.registration,
      permanentPlan: status.permanentPlan, userConfigured: status.userConfigured,
      receivedRevision: status.receivedRevision,
      appliedRevision: status.appliedRevision })}\n`);
    return;
  }
  const code = args[0] === 'begin' ? await readInvitation(input) : null;
  if (code) decodeAwgBootstrapInvitation(code);
  const host = await openHost(config);
  if (args[0] === 'configure-user') {
    const state = await host.connectionStore.read();
    if (state?.status !== 'registered') throw new Error('Registered Cell required for user config');
    if (!input || typeof input[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('Cell user config required on stdin');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 8192) throw new Error('Cell user config is too large');
      chunks.push(bytes);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Invalid Cell user config JSON'); }
    if (value?.server?.privateKey === state.permanent?.privateKey) {
      throw new Error('Cell user and control AWG keys must be distinct');
    }
    const store = newUserStore(path.join(config.stateDirectory, 'user-config.json'), {
      interfaceName: config.resources.interfaceNames[2],
      listenPort: config.resources.udpPorts[0],
    });
    await store.create(value);
    output.write('{"status":"user-configured"}\n');
    return;
  }
  if (args[0] === 'serve') {
    let connection = await host.connectionStore.read();
    let beganNow = false;
    if (!connection && config.invitationFile) {
      const code = await readPrivateInvitationFile(config.invitationFile);
      const begun = await host.initial.begin(code);
      if (begun?.ready !== true) throw new Error('Cell bootstrap did not become ready');
      beganNow = true;
      connection = await host.connectionStore.read();
    }
    if (connection?.status === 'pending') {
      if (!beganNow) {
        const resumed = await host.initial.resume();
        if (resumed?.ready !== true) throw new Error('Pending Cell bootstrap did not recover');
      }
      if (config.invitationFile) {
        await fs.unlink(config.invitationFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      const registered = await host.registration.register();
      if (registered?.status !== 'registered') throw new Error('Cell registration not complete');
      connection = await host.connectionStore.read();
    }
    if (connection?.status !== 'registered') {
      throw new Error('Cell invitation required before starting the service');
    }
    const plan = await host.permanentPlanStore.read();
    const temporary = await host.bootstrap.lifecycle.load();
    if (!plan || temporary.phase !== 'empty') {
      const joined = await host.permanentJoin.join();
      if (joined?.status !== 'ready') throw new Error('Permanent Cell path is not ready');
    }
    if (config.wanInterface) await ensureUser({ config,
      connection: await host.connectionStore.read(), wanInterface: config.wanInterface });
    const service = await startService({ config, bootstrapHost: host });
    output.write('{"status":"serving","transport":"AWG"}\n');
    return service;
  }
  if (args[0] === 'sync') {
    const result = await syncOnce({ config, bootstrapHost: host });
    if (!result || !['applied', 'no-settings'].includes(result.status)) {
      throw new Error('Cell settings sync did not reach a known state');
    }
    output.write(`${JSON.stringify({ status: result.status,
      ...(result.status === 'applied' ? { revision: result.revision } : {}) })}\n`);
    return;
  }
  const result = args[0] === 'begin' ? await host.initial.begin(code)
    : args[0] === 'resume' ? await host.initial.resume()
      : args[0] === 'register' ? await host.registration.register()
        : await host.permanentJoin.join();
  if (args[0] === 'register') {
    if (result?.status !== 'registered') throw new Error('Cell registration not complete');
    output.write('{"status":"registered"}\n');
  } else if (args[0] === 'join') {
    if (!['ready', 'waiting-for-permanent-path'].includes(result?.status)) {
      throw new Error('Permanent Cell join did not reach a known state');
    }
    output.write(`${JSON.stringify({ status: result.status })}\n`);
  } else {
    if (result?.ready !== true) throw new Error('Cell bootstrap not ready');
    output.write('{"status":"bootstrap-ready"}\n');
  }
}

module.exports = { configFromEnvironment, readInvitation, runCellBootstrapCli };
