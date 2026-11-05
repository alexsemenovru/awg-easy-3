'use strict';

const { Application } = require('./lib/Application');
const { installerMessage } = require('./lib/InstallerI18n');

const command = process.argv[2] ?? 'serve';
const application = new Application({
  dataDirectory: process.env.AWG_EASY_DATA_DIR ?? '/data',
  runtimeDirectory: process.env.AWG_EASY_RUNTIME_DIR ?? '/run/awg-easy-3',
  mainCellStatusFile: process.env.AWG_MAIN_STATUS_FILE || null,
});

const printBootstrap = async (result) => {
  const text = (key, ...values) => installerMessage(process.env.AWG_LANG || 'en', key, ...values);
  process.stdout.write([
    '',
    text('AWG-Easy 3 initialized successfully.'),
    text('Panel after VPN connection: %s', result.panelUrl),
    text('Panel password (shown once): %s', result.bootstrapPassword),
    '',
    text('First Home profile for AmneziaVPN:'),
    result.vpnLink,
    '',
  ].join('\n'));
};

const main = async () => {
  if (command === 'init') {
    return printBootstrap(await application.initialize({
      endpointHost: process.env.AWG_HOST || undefined,
      wanInterface: process.env.AWG_WAN_INTERFACE || undefined,
      firstClientName: process.env.AWG_FIRST_CLIENT_NAME || 'Home admin',
      listenPort: process.env.AWG_PORT === undefined ? 51820 : Number(process.env.AWG_PORT),
      panelPort: process.env.AWG_PANEL_PORT === undefined ? 51821 : Number(process.env.AWG_PANEL_PORT),
      uiLanguage: process.env.AWG_LANG || 'en',
    }));
  }
  if (command === 'settings') {
    const settings = await application.settings();
    process.stdout.write(Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(''));
    return;
  }
  if (command === 'reset-password') {
    const password = await application.resetPassword(process.argv[3]);
    process.stdout.write(`New panel password (shown once): ${password}\n`);
    return;
  }
  if (command === 'export-client') {
    const exported = await application.exportClient(process.argv[3]);
    process.stdout.write(`AmneziaVPN profile for ${exported.clientName}:\n${exported.vpnLink}\n`);
    return;
  }
  if (command !== 'serve') throw new Error(`Unknown command: ${command}`);

  const address = await application.start();
  process.stdout.write(`AWG-Easy 3 panel listening on http://${address.address}:${address.port}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await application.stop();
  };
  process.once('SIGTERM', () => stop().then(() => process.exit(0)).catch((error) => {
    console.error(error); process.exit(1);
  }));
  process.once('SIGINT', () => stop().then(() => process.exit(0)).catch((error) => {
    console.error(error); process.exit(1);
  }));
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
