'use strict';

const path = require('node:path');
const { buildCellArtifacts } = require('./CellArtifacts');
const { CellRoutingGuard } = require('./CellRoutingGuard');
const { CellNftPolicyReceipt } = require('./CellNftPolicyReceipt');
const { matchesAwgConfig } = require('./CellAwgSnapshot');
const { TABLE_NAME } = require('./NftablesPolicy');
const { RuntimeApplier } = require('./RuntimeApplier');
const { CellDockerForwarding } = require('./CellDockerForwarding');
const { runProcess } = require('./ProcessRunner');

const GUARD = 'awg_easy_3_cell_guard';

// Cell-only adapter, not enabled in the main panel. The product must pass a
// persistent stateDirectory; /run is not suitable for the guard journal.
class CellRuntimeAdapter {
  constructor({ server, runtimeDirectory, stateDirectory,
    geoDatabase = async () => ({}), runner = runProcess,
    runtime = new RuntimeApplier({ runtimeDirectory, runner }), retainGuard = false,
    guard = null, policyReceipt = null, verifyRuntime = null, dockerForwarding = null }) {
    if (!guard && (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
      || (process.platform !== 'win32' && /^\/run(?:\/|$)/.test(stateDirectory)))) {
      throw new TypeError('Persistent absolute cell state directory required');
    }
    const ownedGuard = guard || new CellRoutingGuard({
      journalPath: path.join(stateDirectory, 'guard.json'), table: GUARD, runner });
    const ownedReceipt = policyReceipt || (stateDirectory ? new CellNftPolicyReceipt({
      filePath: path.join(stateDirectory, 'nft-receipt.json'), runner }) : null);
    if (!['recover', 'protect', 'release'].every(name => typeof ownedGuard[name] === 'function')
      || ownedReceipt && !['assertKnown', 'recordCurrent', 'matchesCurrent']
        .every(name => typeof ownedReceipt[name] === 'function')
      || verifyRuntime !== null && typeof verifyRuntime !== 'function'
      || typeof retainGuard !== 'boolean'
      || retainGuard && typeof ownedGuard.current !== 'function') {
      throw new TypeError('Durable cell guard and runtime verifier required');
    }
    this.server = structuredClone(server);
    this.geoDatabase = geoDatabase;
    this.runner = runner;
    this.runtime = runtime;
    this.guard = ownedGuard;
    this.policyReceipt = ownedReceipt;
    this.dockerForwarding = dockerForwarding || new CellDockerForwarding({ server, runner });
    this.verifyRuntime = verifyRuntime || (artifacts => this.verifyApplied(artifacts));
    this.retainGuard = retainGuard;
  }

  async validate(settings) {
    buildCellArtifacts({ server: this.server, settings, geoDatabase: await this.geoDatabase() });
    return settings;
  }

  async prepareBoot() {
    await this.guard.recover();
    await this.guard.protect([this.server.interfaceName]);
  }

  async requireKnownPolicyBeforeReplacement() {
    if (typeof this.runtime.tableExists !== 'function'
      || typeof this.runtime.readOptional !== 'function'
      || !this.runtime.runtimeDirectory) {
      throw new Error('Cell runtime cannot verify existing nft policy ownership');
    }
    if (!await this.runtime.tableExists()) return;
    const saved = await this.runtime.readOptional(
      path.join(this.runtime.runtimeDirectory, 'rules.nft'));
    if (!saved || !saved.includes(`table inet ${TABLE_NAME} {`)) {
      throw new Error('Existing AWG-Easy nft table has no saved cell policy; refusing replacement');
    }
  }

  async verifyApplied(artifacts) {
    if (!this.runtime.runtimeDirectory || typeof this.runtime.readOptional !== 'function') return false;
    const directory = this.runtime.runtimeDirectory;
    const interfaceName = this.server.interfaceName;
    try {
      const [config, policy, stripped, actual] = await Promise.all([
        this.runtime.readOptional(path.join(directory, `${interfaceName}.conf`)),
        this.runtime.readOptional(path.join(directory, 'rules.nft')),
        typeof this.runtime.stripSavedConfig === 'function' ? this.runtime.stripSavedConfig(interfaceName)
          : this.runner('awg-quick', ['strip', path.join(directory, `${interfaceName}.conf`)]),
        this.runner('awg', ['showconf', interfaceName]),
      ]);
      if (config !== artifacts.serverConfig || policy !== artifacts.nftables
        || !matchesAwgConfig(stripped.stdout, actual.stdout)) return false;
      if (this.policyReceipt) return this.policyReceipt.matchesCurrent();
      await this.runner('nft', ['list', 'table', 'inet', TABLE_NAME]);
      return true;
    } catch { return false; }
  }

  async apply(settings, { geoDatabase } = {}) {
    const artifacts = buildCellArtifacts({ server: this.server, settings,
      geoDatabase: geoDatabase === undefined ? await this.geoDatabase() : geoDatabase });
    let active;
    try {
      await this.runner('ip', ['link', 'show', 'dev', this.server.interfaceName]);
      active = true;
    } catch (error) {
      if (error.code !== 1 && error.exitCode !== 1) throw error;
      active = false;
    }
    if (active && (!this.runtime.runtimeDirectory || typeof this.runtime.readOptional !== 'function'
      || !await this.runtime.readOptional(path.join(this.runtime.runtimeDirectory,
        `${this.server.interfaceName}.conf`)))) {
      throw new Error('Existing interface has no owned cell configuration; refusing to touch it');
    }
    await this.guard.recover();
    await this.guard.protect([this.server.interfaceName]);
    await this.requireKnownPolicyBeforeReplacement();
    if (this.policyReceipt) await this.policyReceipt.assertKnown();
    // Keep guard on ANY uncertain outcome, including rollback failure. A later
    // retry restores the last signed applied snapshot before removing it.
    await this.runtime.apply({ ...artifacts, interfaceActive: active });
    if (this.policyReceipt) await this.policyReceipt.recordCurrent();
    await this.dockerForwarding.ensure();
    if (!this.retainGuard) await this.guard.release(() => this.verifyRuntime(artifacts));
  }

  async releaseForRouting(verifyRouting) {
    if (!this.retainGuard || typeof verifyRouting !== 'function') {
      throw new TypeError('Retained user guard and routing verifier required');
    }
    await this.guard.release(verifyRouting);
  }

  async userGuardActive() {
    const state = await this.guard.load();
    return state.pending !== null || state.interfaces.length > 0
      || await this.guard.current() !== null;
  }
}

module.exports = { CellRuntimeAdapter };
