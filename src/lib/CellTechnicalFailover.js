'use strict';

const path = require('node:path');
const net = require('node:net');
const { runProcess } = require('./ProcessRunner');
const { withCellInstallationLock } = require('./CellInstallationLock');
const { permanentPathFromPlan } = require('./CellAwgPermanentDeployment');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { CellControlRedirect } = require('./CellControlRedirect');
const { probeControlTcp } = require('./CellAwgPermanentVerifier');

// Only the permanent CONTROL AWG tuple may enter the reserve. User/data
// interfaces, keys, peer endpoints and Internet routes never change here.
class CellTechnicalFailover {
  constructor({ directory, discovery, snapshot, locked, redirect, reachable = async () => false, now = Date.now }) {
    Object.assign(this, { directory, discovery, snapshot, locked, redirect, reachable, now });
    this.active = false;
    this.since = 0;
    this.retryAt = 0;
    this.stopped = false;
    this.pending = Promise.resolve();
    this.busy = false;
    this.status = 'direct';
  }
  async prepare() {
    await this.locked(() => this.redirect.recover());
  }
  report(poll) {
    if (this.stopped || this.busy || !['connected', 'degraded'].includes(poll.state)) return;
    this.busy = true;
    this.pending = this.update(poll).catch(() => { this.status = 'unavailable'; })
      .finally(() => { this.busy = false; });
  }
  async direct() {
    // Keep the bridge alive until reverse NAT/conntrack is removed.
    await this.locked(() => this.redirect.recover());
    await this.discovery()?.closeBridge?.();
    this.active = false;
    this.status = 'direct';
  }
  async update(poll) {
    const discovery = this.discovery();
    if (this.active && (this.now() - this.since >= 300000
      || discovery?.status().technical?.bridgeActive === false
      || poll.state === 'degraded' && poll.consecutiveFailures >= 3 && !await this.reachable())) {
      await this.direct();
      this.retryAt = this.now() + 10000;
      return;
    }
    if (this.active || this.stopped || poll.state !== 'degraded'
      || poll.consecutiveFailures < 3 || this.now() < this.retryAt
      || typeof discovery?.openBridge !== 'function') return;
    this.retryAt = this.now() + 60000;
    // A routing/GeoIP/data-link failure is not evidence that control AWG is
    // down. Never reroute control just because a later settings step failed.
    if (await this.reachable()) return;
    const before = await this.locked(this.snapshot);
    const address = await discovery.openBridge(before.target, before.tuple.source4);
    if (this.stopped) { await discovery.closeBridge(); return; }
    try {
      await this.locked(async () => {
        const current = await this.snapshot();
        if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error('Control ownership changed during discovery');
        if (address.address !== '127.0.0.1') throw new Error('Non-local technical bridge');
        await this.redirect.apply({ ...before.tuple, bridgePort: address.port });
      });
      this.active = true;
      this.since = this.now();
      this.status = 'technical';
    } catch (error) {
      // A partial apply has a durable journal. Recover it before closing the
      // UDP bridge; on an ownership conflict preserve evidence and stop.
      try { await this.locked(() => this.redirect.recover()); }
      finally { await discovery.closeBridge(); }
      throw error;
    }
  }
  async close() {
    this.stopped = true;
    await this.pending;
    await this.direct();
  }
}

function createCellTechnicalFailover({ config, bootstrapHost, discovery, runner = runProcess,
  withLock = withCellInstallationLock, buildPath = permanentPathFromPlan }) {
  const directory = path.join(config.stateDirectory, 'technical');
  const locked = work => withLock({ lockPath: path.join(config.stateDirectory, 'install.lock'), work });
  const snapshot = async () => {
    const connection = await bootstrapHost.connectionStore.read();
    const plan = await bootstrapHost.permanentPlanStore.read();
    if (connection?.status !== 'registered' || !plan) throw new Error('Registered control plan required');
    const control = buildPath({ stateDirectory: path.join(config.stateDirectory, 'permanent'), plan, runner });
    if (control.interfaceName !== config.resources.interfaceNames[1] || !await control.verifyOwned()) {
      throw new Error('Permanent control ownership is unproven');
    }
    const parsed = normalizeAwgConfig(plan.spec.owner.config);
    const match = parsed.peers.length === 1 && parsed.peers[0].endpoint?.match(/^([^:]+):(\d+)$/);
    if (!match || net.isIP(match[1]) !== 4) throw new Error('IPv4 control endpoint required for reserve');
    const sourcePort = Number((await runner('awg', ['show', control.interfaceName, 'listen-port'],
      { timeoutMs: 3000, maxOutputBytes: 128 })).stdout);
    if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) throw new Error('Owned control socket unavailable');
    const routes = JSON.parse((await runner('ip', ['-j', '-4', 'route', 'get', match[1]],
      { timeoutMs: 3000, maxOutputBytes: 4096 })).stdout);
    const source4 = routes.length === 1 && (routes[0].prefsrc || routes[0].src);
    if (net.isIP(source4) !== 4 || routes[0].dst !== match[1]) throw new Error('Control source route unavailable');
    return { target: connection.controllerKey, tuple: { interfaceName: control.interfaceName,
      ownerTag: plan.spec.owner.ownerTag, source4, sourcePort, peer4: match[1], peerPort: Number(match[2]) } };
  };
  const redirect = new CellControlRedirect({ directory, runner, verifyOwned: async (value, { recovering }) => {
    const current = await snapshot();
    // A reboot may change the ephemeral listen port or WAN address. The
    // durable owner/peer proof still authorizes removal of our exact old NAT
    // tuple, never installation of a redirect for that obsolete socket.
    return Object.entries(current.tuple).every(([key, expected]) =>
      recovering && ['source4', 'sourcePort'].includes(key) || value[key] === expected);
  } });
  const reachable = async () => {
    const connection = await bootstrapHost.connectionStore.read();
    if (connection?.status !== 'registered' || !connection.controllerPath) return false;
    const descriptor = connection.controllerPath;
    return probeControlTcp({ address: descriptor.controllerAddress,
      port: descriptor.controlPort, localAddress: descriptor.cellAddress });
  };
  return new CellTechnicalFailover({ directory, discovery, snapshot, locked, redirect, reachable });
}

module.exports = { CellTechnicalFailover, createCellTechnicalFailover };
