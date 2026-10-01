'use strict';
// Disposable test-only diagnostics. Never prints private fixture contents.
const fs = require('node:fs');
const { compileCellRouting } = require('../src/lib/CellRoutingPolicy');
const { CellRoutingGuard } = require('../src/lib/CellRoutingGuard');
const { specification: deviceSpec } = require('../src/lib/CellAwgLifecycle');
const { CellRoutingCoordinator } = require('../src/lib/CellRoutingCoordinator');
const [bundleFile, stateDirectory] = process.argv.slice(2);
let stage = 'load';
(async () => {
  try {
    const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
    stage = 'compile';
    compileCellRouting(bundle);
    stage = 'devices';
    bundle.devices.map(deviceSpec);
    stage = 'guard';
    const current = await new CellRoutingGuard({ journalPath: `${stateDirectory}/guard.json` }).current();
    stage = 'coordinator';
    const coordinator = new CellRoutingCoordinator({ directory: stateDirectory, verifyInterfaces: async () => false });
    const saved = await coordinator.load();
    console.log(JSON.stringify({ compile: true, guardPresent: current !== null, committed: saved.committed !== null }));
  } catch (error) {
    const message = String(error.message || '').replace(/[A-Za-z0-9+/]{32,}={0,2}/g, '[redacted]');
    console.error(JSON.stringify({ stage, error: message.slice(0, 200) }));
    process.exitCode = 1;
  }
})();
