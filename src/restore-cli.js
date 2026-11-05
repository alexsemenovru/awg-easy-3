'use strict';
require('./lib/RestoreCli').runRestoreCli({ args: process.argv.slice(2), output: process.stdout })
  .catch(() => { console.error('Restore preparation failed: verify the private archive, matching key, new-host state and empty output path.'); process.exitCode = 1; });
