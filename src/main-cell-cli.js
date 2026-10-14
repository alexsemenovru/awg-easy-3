'use strict';

const { runMainBootstrapCli } = require('./lib/MainBootstrapCli');

runMainBootstrapCli({ args: process.argv.slice(2), env: process.env,
  input: process.stdin, output: process.stdout }).then(service => {
  if (!service || process.argv[2] !== 'serve') return;
  const close = () => service.close().catch(() => { process.exitCode = 1; });
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}).catch(() => {
  // An exception can include invitation material; never print it here.
  console.error('Main bootstrap command failed; check local diagnostics without sharing an invitation');
  process.exitCode = 1;
});
