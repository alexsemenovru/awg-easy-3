'use strict';

const { specification } = require('./CellRoutingCoordinator');

// This runs under the installation-wide lock. Both the dedicated data AWG
// interface and all user-routing interfaces stay guarded until the exact
// routing revision and a real data-link probe are verified. A crash leaves
// durable guards; startup must call activate again before serving clients.
class CellDataActivation {
  constructor({ dataPath, routing, verifyDataLink }) {
    if (!dataPath || !dataPath.retainGuard || !dataPath.lifecycle
      || !['initialize', 'recover', 'verifyOwned', 'releaseAfterRouting']
        .every(name => typeof dataPath[name] === 'function')
      || typeof dataPath.lifecycle.load !== 'function'
      || !routing || !['recover', 'apply', 'verify', 'releaseCommitted']
        .every(name => typeof routing[name] === 'function')
      || typeof verifyDataLink !== 'function') {
      throw new TypeError('Guarded data path, routing coordinator and link probe required');
    }
    this.dataPath = dataPath;
    this.routing = routing;
    this.verifyDataLink = verifyDataLink;
  }

  async activate(value) {
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
    await this.dataPath.releaseAfterRouting(async () =>
      await this.routing.verify(desired) && await this.verifyDataLink() === true);
    await this.routing.releaseCommitted();
    return { ready: true };
  }
}

module.exports = { CellDataActivation };
