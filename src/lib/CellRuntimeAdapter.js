'use strict';

const path = require('node:path');
const { buildCellArtifacts } = require('./CellArtifacts');
const { RuntimeApplier } = require('./RuntimeApplier');
const { runProcess } = require('./ProcessRunner');
const GUARD = 'awg_easy_3_cell_guard';

function guardPolicy(interfaceName) {
  if (typeof interfaceName !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(interfaceName)) {
    throw new TypeError('Invalid cell interface');
  }
  return `table inet ${GUARD} {
  chain input { type filter hook input priority -20; policy accept; iifname "${interfaceName}" drop; }
  chain output { type filter hook output priority -20; policy accept; oifname "${interfaceName}" drop; }
  chain forward { type filter hook forward priority -20; policy accept; iifname "${interfaceName}" drop; oifname "${interfaceName}" drop; }
}\n`;
}

// Cell-only adapter, not enabled in the main panel. Server context is local/trusted.
class CellRuntimeAdapter {
  constructor({ server, runtimeDirectory, geoDatabase = async () => ({}), runner = runProcess,
    runtime = new RuntimeApplier({ runtimeDirectory, runner }) }) {
    this.server = structuredClone(server);
    this.geoDatabase = geoDatabase;
    this.runner = runner;
    this.runtime = runtime;
  }

  async validate(settings) {
    buildCellArtifacts({ server: this.server, settings, geoDatabase: await this.geoDatabase() });
    return settings;
  }

  async apply(settings) {
    const artifacts = buildCellArtifacts({ server: this.server, settings, geoDatabase: await this.geoDatabase() });
    let active;
    try {
      await this.runner('ip', ['link', 'show', 'dev', this.server.interfaceName]);
      active = true;
    } catch (error) {
      if (error.code !== 1 && error.exitCode !== 1) throw error;
      active = false;
    }
    if (active && (!this.runtime.runtimeDirectory || typeof this.runtime.readOptional !== 'function'
      || !await this.runtime.readOptional(path.join(this.runtime.runtimeDirectory, `${this.server.interfaceName}.conf`)))) {
      throw new Error('Existing interface has no owned cell configuration; refusing to touch it');
    }
    let exists;
    try { await this.runner('nft', ['list', 'table', 'inet', GUARD]); exists = true; }
    catch (error) {
      if (error.code !== 1 && error.exitCode !== 1) throw error;
      exists = false;
    }
    if (exists) {
      throw new Error('Existing cell guard table requires explicit ownership recovery');
    }
    const input = guardPolicy(this.server.interfaceName);
    await this.runner('nft', ['-c', '-f', '-'], { input });
    await this.runner('nft', ['-f', '-'], { input });
    // Keep guard on ANY uncertain outcome, including rollback failure. A later
    // explicit retry/restore must apply a known snapshot before removing it.
    await this.runtime.apply({ ...artifacts, interfaceActive: active });
    await this.runner('nft', ['delete', 'table', 'inet', GUARD]);
  }
}

module.exports = { CellRuntimeAdapter, guardPolicy };
