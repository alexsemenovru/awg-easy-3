'use strict';

const { runCellBootstrapCli } = require('./lib/CellBootstrapCli');

runCellBootstrapCli({ args: process.argv.slice(2), env: process.env,
  input: process.stdin, output: process.stdout }).catch(() => {
  // A dependency error may include invitation material. Never echo it here.
  console.error('Cell bootstrap command failed; check local diagnostics without sharing the invitation');
  process.exitCode = 1;
});
