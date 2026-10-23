'use strict';

const path = require('node:path');
const { openMainBootstrapInstallationHost } = require('./MainBootstrapInstallationHost');
const { MainCellStatusSnapshot } = require('./MainCellStatusSnapshot');
const { MainCellEntrySnapshot } = require('./MainCellEntrySnapshot');
const { listenInvitationSocket } = require('./MainCellInvitationSocket');

const NAME = /^[a-zA-Z0-9_.-]{1,15}$/;
const PORT = /^\d{1,5}$/;
const port = value => PORT.test(value || '') && Number(value) > 0 && Number(value) <= 65535
  ? Number(value) : NaN;
const transientPath = error => error?.message === 'Permanent AWG path is not operational after boot recovery'
  || error?.message === 'Permanent Main control path is not operational';

function configFromEnvironment(env) {
  if (!env || typeof env !== 'object') throw new TypeError('Main environment required');
  const stateDirectory = env.AWG_MAIN_CELL_STATE_DIR;
  const userStateFile = env.AWG_MAIN_USER_STATE_FILE;
  const statusFile = env.AWG_MAIN_STATUS_FILE;
  const invitationSocket = env.AWG_MAIN_INVITATION_SOCKET;
  const interfaceName = env.AWG_MAIN_BOOTSTRAP_INTERFACE;
  const permanentInterface = env.AWG_MAIN_CONTROL_INTERFACE;
  const userInterface = env.AWG_MAIN_USER_INTERFACE;
  const userPort = port(env.AWG_MAIN_USER_PORT);
  const listenPort = port(env.AWG_MAIN_BOOTSTRAP_PORT);
  const permanentEndpointPort = port(env.AWG_MAIN_CONTROL_PORT);
  const registrationPort = port(env.AWG_MAIN_REGISTRATION_PORT);
  const permanentControlPort = port(env.AWG_MAIN_CONTROL_TCP_PORT);
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || path.normalize(stateDirectory) !== stateDirectory
    || (userStateFile !== undefined && (typeof userStateFile !== 'string'
      || !path.isAbsolute(userStateFile) || path.normalize(userStateFile) !== userStateFile))
    || (invitationSocket !== undefined && (typeof invitationSocket !== 'string'
      || !path.isAbsolute(invitationSocket) || path.normalize(invitationSocket) !== invitationSocket))
    || (statusFile !== undefined && (typeof statusFile !== 'string'
      || !path.isAbsolute(statusFile) || path.normalize(statusFile) !== statusFile))
    || !NAME.test(interfaceName || '') || !NAME.test(permanentInterface || '')
    || !NAME.test(userInterface || '')
    || new Set([interfaceName, permanentInterface, userInterface]).size !== 3
    || [listenPort, permanentEndpointPort, registrationPort, permanentControlPort, userPort]
      .some(value => !Number.isSafeInteger(value))
    || registrationPort === permanentControlPort
    || new Set([listenPort, permanentEndpointPort, userPort]).size !== 3) {
    throw new Error('Explicit Main state path, three distinct interfaces and five ports required');
  }
  return { stateDirectory, userStateFile, statusFile, invitationSocket, interfaceName,
    controllerAddress: env.AWG_MAIN_BOOTSTRAP_ADDRESS,
    registrationPort, listenPort, endpointHost: env.AWG_MAIN_ENDPOINT,
    permanentEndpointPort, permanentControllerAddress: env.AWG_MAIN_CONTROL_ADDRESS,
    permanentControlPort,
    resources: { interfaceNames: [interfaceName, permanentInterface],
      udpPorts: [listenPort, permanentEndpointPort],
      userInterfaceNames: [userInterface], userUdpPorts: [userPort], nftTables: [
        'awg_easy_3_bootstrap', 'awg_easy_3_bootstrap_guard',
        'awg_easy_3_control', 'awg_easy_3_control_guard',
      ] },
  };
}

async function readSettings(input) {
  if (!input || typeof input[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('Settings JSON required on stdin');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 2 * 1024 * 1024) throw new Error('Cell settings exceed size limit');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid Cell settings JSON'); }
}

async function runMainBootstrapCli({ args, env, input, output,
  openHost = openMainBootstrapInstallationHost,
  newStatusSnapshot = file => new MainCellStatusSnapshot(file),
  newEntrySnapshot = file => new MainCellEntrySnapshot(file) } = {}) {
  if (!Array.isArray(args) || !output || typeof output.write !== 'function'
    || !['init', 'resume', 'issue', 'issue-auto', 'join', 'serve', 'listen', 'control-listen', 'cells',
      'publish', 'settings-status'].includes(args[0])
    || args.length !== (args[0] === 'issue' ? 3
      : ['join', 'publish', 'settings-status'].includes(args[0]) ? 2 : 1)) {
    throw new Error('Usage: main-cell-cli.js init|resume|issue TEMP_IP PERMANENT_IP|issue-auto|join ID|serve|listen|control-listen|cells|publish ID|settings-status ID');
  }
  const settings = args[0] === 'publish' ? await readSettings(input) : null;
  const config = configFromEnvironment(env);
  const host = await openHost(config);
  if (args[0] === 'init' || args[0] === 'resume') {
    const result = await host[args[0] === 'init' ? 'initialize' : 'resume']();
    if (result?.ready !== true) throw new Error('Main bootstrap not ready');
    output.write('{"status":"bootstrap-ready"}\n');
  } else if (args[0] === 'issue') {
    const code = await host.issue({ cellAddress: args[1], permanentCellAddress: args[2] });
    output.write(`${code}\n`);
  } else if (args[0] === 'issue-auto') {
    output.write(`${await host.issueAuto()}\n`);
  } else if (args[0] === 'join') {
    const result = await host.join(args[1]);
    if (!['ready', 'waiting-for-permanent-path'].includes(result?.status)) {
      throw new Error('Permanent Main join did not reach a known state');
    }
    output.write(`${JSON.stringify({ status: result.status })}\n`);
  } else if (args[0] === 'publish') {
    const result = await host.publish(args[1], settings);
    output.write(`${JSON.stringify({ revision: result.revision })}\n`);
  } else if (args[0] === 'settings-status') {
    output.write(`${JSON.stringify(await host.settingsStatus(args[1]))}\n`);
  } else if (args[0] === 'cells') {
    output.write(`${JSON.stringify(await host.cells())}\n`);
  } else if (args[0] === 'serve') {
    // The long-lived service must own the userspace AWG process on first boot.
    // A short-lived compose run --rm init would destroy that process. Never
    // interpret a failed recovery as permission to create a new identity.
    if (await host.isPristine()) await host.initialize();
    else await host.resume();
    let boot;
    try { boot = await host.recoverPermanentBoot(); }
    catch (error) {
      if (!transientPath(error)) throw error;
      // A disconnected Cell cannot suppress the Main registration listener.
      // The permanent control listener remains closed until verified recovery.
      boot = { configured: true };
    }
    let registration;
    let control;
    let statusTimer;
    let invitationListener;
    let reconcileTimer;
    let statusRefresh = Promise.resolve();
    let reconciliation = Promise.resolve();
    try {
      registration = await host.listen();
      if (boot.configured) {
        try { control = await host.listenControl(); }
        catch (error) { if (!transientPath(error)) throw error; }
      }
      const reconcile = () => reconciliation = reconciliation.catch(() => {}).then(async () => {
        const cells = await host.cells();
        for (const cell of cells) {
          if (cell.status === 'consumed' && cell.phase !== 'closed') {
            await host.join(cell.id);
          } else if (cell.status === 'consumed' && cell.phase === 'closed'
            && cell.settings?.desiredRevision === null) {
            await host.ensureInitialSettings(cell.id);
          }
          if (config.userStateFile && cell.status === 'consumed'
            && cell.phase === 'closed' && typeof host.dataPublicKey === 'function'
            && typeof host.userDescriptor === 'function'
            && typeof host.prepareDataOffer === 'function'
            && await host.dataPublicKey(cell.id) && await host.userDescriptor(cell.id)) {
            // Idempotent reservation only. A signed offer does not activate
            // routing or authorize Home traffic before verified data startup.
            await host.prepareDataOffer(cell.id);
          }
        }
        await host.reconcileClientAssignments();
        if (!control) {
          try {
            const current = await host.recoverPermanentBoot();
            if (current.configured) control = await host.listenControl();
          } catch (error) { if (!transientPath(error)) throw error; }
        }
      });
      let warned = false;
      reconcileTimer = setInterval(() => {
        reconcile().then(() => { warned = false; }).catch(() => {
          if (!warned) console.warn('Main Cell reconciliation needs attention');
          warned = true;
        });
      }, 5000);
      reconcileTimer.unref();
      if (config.statusFile) {
        const snapshot = newStatusSnapshot(config.statusFile);
        const entrySnapshot = newEntrySnapshot(path.join(path.dirname(config.statusFile), 'entries.json'));
        const refresh = () => statusRefresh = statusRefresh.catch(() => {}).then(async () => {
          await entrySnapshot.write(await host.entryDescriptors());
          await snapshot.write(await host.cells());
        });
        await refresh();
        let statusWarned = false;
        statusTimer = setInterval(() => {
          refresh().then(() => { statusWarned = false; }).catch(() => {
            if (!statusWarned) console.warn('Main Cell status snapshot is unavailable');
            statusWarned = true;
          });
        }, 15000);
        statusTimer.unref();
      }
      if (config.invitationSocket) {
        invitationListener = await listenInvitationSocket(config.invitationSocket, () => host.issueAuto());
      }
      output.write(`${JSON.stringify({ status: 'serving',
        permanentConfigured: boot.configured === true })}\n`);
      return { close: async () => {
        if (statusTimer) clearInterval(statusTimer);
        if (reconcileTimer) clearInterval(reconcileTimer);
        await statusRefresh.catch(() => {});
        await reconciliation.catch(() => {});
        if (invitationListener) await invitationListener.close();
        try { if (control) await control.close(); }
        finally { await registration.close(); }
      }, reconcile };
    } catch (error) {
      if (statusTimer) clearInterval(statusTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (invitationListener) await invitationListener.close();
      try { if (control) await control.close(); }
      finally { if (registration) await registration.close(); }
      throw error;
    }
  } else if (args[0] === 'control-listen') {
    const listener = await host.listenControl();
    output.write('{"controlListening":true,"transport":"AWG"}\n');
    return listener;
  } else {
    const listener = await host.listen();
    output.write('{"listening":true,"transport":"AWG"}\n');
    return listener;
  }
}

module.exports = { configFromEnvironment, runMainBootstrapCli };
