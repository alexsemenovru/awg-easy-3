'use strict';

const path = require('node:path');
const { openMainBootstrapInstallationHost } = require('./MainBootstrapInstallationHost');

const NAME = /^[a-zA-Z0-9_.-]{1,15}$/;
const PORT = /^\d{1,5}$/;
const port = value => PORT.test(value || '') && Number(value) > 0 && Number(value) <= 65535
  ? Number(value) : NaN;

function configFromEnvironment(env) {
  if (!env || typeof env !== 'object') throw new TypeError('Main environment required');
  const stateDirectory = env.AWG_MAIN_CELL_STATE_DIR;
  const userStateFile = env.AWG_MAIN_USER_STATE_FILE;
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
    || !NAME.test(interfaceName || '') || !NAME.test(permanentInterface || '')
    || !NAME.test(userInterface || '')
    || new Set([interfaceName, permanentInterface, userInterface]).size !== 3
    || [listenPort, permanentEndpointPort, registrationPort, permanentControlPort, userPort]
      .some(value => !Number.isSafeInteger(value))
    || new Set([listenPort, permanentEndpointPort, userPort]).size !== 3) {
    throw new Error('Explicit Main state path, three distinct interfaces and five ports required');
  }
  return { stateDirectory, userStateFile, interfaceName,
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
  openHost = openMainBootstrapInstallationHost } = {}) {
  if (!Array.isArray(args) || !output || typeof output.write !== 'function'
    || !['init', 'resume', 'issue', 'join', 'serve', 'listen', 'control-listen', 'cells',
      'publish', 'settings-status'].includes(args[0])
    || args.length !== (args[0] === 'issue' ? 3
      : ['join', 'publish', 'settings-status'].includes(args[0]) ? 2 : 1)) {
    throw new Error('Usage: main-cell-cli.js init|resume|issue TEMP_IP PERMANENT_IP|join ID|serve|listen|control-listen|cells|publish ID|settings-status ID');
  }
  const settings = args[0] === 'publish' ? await readSettings(input) : null;
  const host = await openHost(configFromEnvironment(env));
  if (args[0] === 'init' || args[0] === 'resume') {
    const result = await host[args[0] === 'init' ? 'initialize' : 'resume']();
    if (result?.ready !== true) throw new Error('Main bootstrap not ready');
    output.write('{"status":"bootstrap-ready"}\n');
  } else if (args[0] === 'issue') {
    const code = await host.issue({ cellAddress: args[1], permanentCellAddress: args[2] });
    output.write(`${code}\n`);
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
    await host.resume();
    const boot = await host.recoverPermanentBoot();
    let registration;
    let control;
    try {
      registration = await host.listen();
      control = boot.configured ? await host.listenControl() : null;
      output.write(`${JSON.stringify({ status: 'serving',
        permanentConfigured: boot.configured === true })}\n`);
      return { close: async () => {
        try { if (control) await control.close(); }
        finally { await registration.close(); }
      } };
    } catch (error) {
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
