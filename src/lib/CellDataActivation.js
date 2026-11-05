'use strict';

const { specification } = require('./CellRoutingCoordinator');

// This runs under the installation-wide lock. Both the dedicated data AWG
// interface and all user-routing interfaces stay guarded until the exact
// routing revision and a real data-link probe are verified. A crash leaves
// durable guards; startup must call activate again before serving clients.
class CellDataActivation {
  constructor({ dataPath, routing, verifyDataLink, beforeRelease = async () => {} }) {
    if (!dataPath || !dataPath.retainGuard || !dataPath.lifecycle
      || !['initialize', 'recover', 'verifyOwned', 'releaseAfterRouting']
        .every(name => typeof dataPath[name] === 'function')
      || typeof dataPath.lifecycle.load !== 'function'
      || !routing || !['recover', 'apply', 'verify', 'releaseCommitted']
        .every(name => typeof routing[name] === 'function')
      || typeof verifyDataLink !== 'function' || typeof beforeRelease !== 'function') {
      throw new TypeError('Guarded data path, routing coordinator and link probe required');
    }
    this.dataPath = dataPath;
    this.routing = routing;
    this.verifyDataLink = verifyDataLink;
    this.beforeRelease = beforeRelease;
  }

  async activate(value, { replayApplied = false } = {}) {
    if (typeof replayApplied !== 'boolean') throw new TypeError('Explicit applied routing replay flag required');
    const desired = specification(value);
    if (!desired.interfaces.includes(this.dataPath.interfaceName)) {
      throw new TypeError('Routing revision omits the data link interface');
    }
    const phase = (await this.dataPath.lifecycle.load()).phase;
    if (phase === 'empty') await this.dataPath.initialize();
    else if (phase === 'creating' || phase === 'ready') await this.dataPath.recover();
    else throw new Error('Data link removal requires explicit recovery');

    // Reconcile an interrupted routing transaction while both paths are
    // protected; only then commit the requested revision.
    await this.routing.recover();
    await this.routing.apply(desired, { retainGuard: true });
    await this.dataPath.releaseAfterRouting(async () => {
      if (!await this.routing.verify(desired)) return false;
      const reachable = await this.verifyDataLink() === true;
      // A previously APPLIED signed route may be reconstructed after reboot
      // while Main is offline. Its exact owned data device still encrypts the
      // unavailable path; routes/blackholes remain unchanged. New revisions
      // always require a live probe before their first release.
      if (!reachable && !(replayApplied && await this.dataPath.verifyOwned())) return false;
      await this.beforeRelease(desired.interfaces);
      return true;
    });
    await this.routing.releaseCommitted();
    return { ready: true };
  }
}

module.exports = { CellDataActivation };
