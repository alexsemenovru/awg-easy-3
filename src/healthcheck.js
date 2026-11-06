'use strict';
const path = require('node:path');
require('./lib/PanelHealth').panelHealth({ stateFile: path.join(process.env.AWG_EASY_DATA_DIR || '/data', 'state.json') })
  .catch(() => { process.exitCode = 1; });
