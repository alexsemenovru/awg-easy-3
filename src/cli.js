'use strict';

const { Application } = require('./lib/Application');

const command = process.argv[2] ?? 'serve';
const application = new Application({
  dataDirectory: process.env.AWG_EASY_DATA_DIR ?? '/data',
  runtimeDirectory: process.env.AWG_EASY_RUNTIME_DIR ?? '/run/awg-easy-3',
});

const printBootstrap = async (result) => {
  const qr = await require('qrcode').toString(result.vpnLink, {
    type: 'terminal', small: true, errorCorrectionLevel: 'M',
  });
  process.stdout.write([
    '',
    'AWG-Easy 3 initialized successfully.',
    `Panel after VPN connection: ${result.panelUrl}`,
    `Panel password (shown once): ${result.bootstrapPassword}`,
    '',
    'First Home profile for AmneziaVPN:',
    qr,
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
    }));
  }
  if (command === 'reset-password') {
    const password = await application.resetPassword(process.argv[3]);
    process.stdout.write(`New panel password (shown once): ${password}\n`);
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
