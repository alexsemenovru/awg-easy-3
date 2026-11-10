'use strict';
const fs = require('node:fs');
const path = require('node:path');
try {
  const file = path.join(path.dirname(process.env.AWG_MAIN_STATUS_FILE), 'main-ready.json');
  const stat = fs.lstatSync(file);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024
    || value.version !== require('./package.json').version || value.pid !== 1 && value.pid < 2
    || !Number.isSafeInteger(value.pid) || !fs.existsSync(`/proc/${value.pid}`)
    || !fs.statSync(process.env.AWG_MAIN_INVITATION_SOCKET).isSocket()) throw new Error();
} catch { process.exitCode = 1; }
