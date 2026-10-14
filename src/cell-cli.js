'use strict';

const { runCellBootstrapCli } = require('./lib/CellBootstrapCli');

runCellBootstrapCli({ args: process.argv.slice(2), env: process.env,
  input: process.stdin, output: process.stdout }).then(service => {
  if (!service || process.argv[2] !== 'serve') return;
  service.running.catch(() => {
    console.error('Cell settings service stopped unexpectedly');
    process.exitCode = 1;
  });
  const close = () => service.close().catch(() => { process.exitCode = 1; });
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}).catch(() => {
  // A dependency error may include invitation material. Never echo it here.
  console.error('Cell bootstrap command failed; check local diagnostics without sharing the invitation');
  process.exitCode = 1;
});
