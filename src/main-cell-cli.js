'use strict';

const { runMainBootstrapCli } = require('./lib/MainBootstrapCli');

runMainBootstrapCli({ args: process.argv.slice(2), env: process.env,
  output: process.stdout }).catch(() => {
  // An exception can include invitation material; never print it here.
  console.error('Main bootstrap command failed; check local diagnostics without sharing an invitation');
  process.exitCode = 1;
});
