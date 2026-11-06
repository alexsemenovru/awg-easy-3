'use strict';
process.title = 'network-service';

// Neutral long-running entrypoint for the headless Cell. Administrative
// commands continue to use cell-cli.js directly; neither path takes secrets
// or client addresses through command-line arguments.
require('./lib/PrivateStateText').prepareCellStateFiles().then(() => require('./cell-cli')).catch(() => {
  console.error('Private network state preparation failed'); process.exitCode = 1;
});
