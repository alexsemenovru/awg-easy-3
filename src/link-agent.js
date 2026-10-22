'use strict';

// Neutral long-running entrypoint for the headless Cell. Administrative
// commands continue to use cell-cli.js directly; neither path takes secrets
// or client addresses through command-line arguments.
require('./cell-cli');
