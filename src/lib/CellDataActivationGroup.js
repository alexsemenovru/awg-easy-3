'use strict';

const { specification } = require('./CellRoutingCoordinator');

// All Main-to-Cell data paths share one Main routing policy. Keep the common
// user-routing guard on until every constituent AWG path, route and handshake
// has been verified. A partial release cannot open client forwarding.
class CellDataActivationGroup {
  constructor({ dataPaths, routing, verifyDataLink }) {
    if (!Array.isArray(dataPaths) || !dataPaths.length
      || new Set(dataPaths.map(path => path.interfaceName)).size !== dataPaths.length
      || dataPaths.some(path => !path || !path.retainGuard || !path.lifecycle
        || !['initialize', 'recover', 'verifyOwned', 'releaseAfterRouting']
          .every(name => typeof path[name] === 'function')
        || typeof path.lifecycle.load !== 'function')
      || !routing || !['recover', 'apply', 'verify', 'releaseCommitted']
        .every(name => typeof routing[name] === 'function')
      || typeof verifyDataLink !== 'function') {
      throw new TypeError('Guarded Cell data paths and routing coordinator required');
    }
    this.dataPaths = dataPaths;
    this.routing = routing;
    this.verifyDataLink = verifyDataLink;
  }

  async activate(value) {
    const desired = specification(value);
    if (this.dataPaths.some(path => !desired.interfaces.includes(path.interfaceName))) {
      throw new TypeError('Routing revision omits a data link interface');
    }
    for (const path of this.dataPaths) {
      const phase = (await path.lifecycle.load()).phase;
      if (phase === 'empty') await path.initialize();
      else if (phase === 'creating' || phase === 'ready') await path.recover();
      else throw new Error('Data link removal requires explicit recovery');
    }
    await this.routing.recover();
    await this.routing.apply(desired, { retainGuard: true });
    const verified = async () => await this.routing.verify(desired)
      && await Promise.all(this.dataPaths.map(async path =>
        await path.verifyOwned() && await this.verifyDataLink(path.interfaceName) === true))
        .then(results => results.every(Boolean));
    if (!await verified()) throw new Error('Cell data links are not all verified');
    for (const path of this.dataPaths) {
      await path.releaseAfterRouting(verified);
    }
    await this.routing.releaseCommitted();
    return { ready: true, links: this.dataPaths.length };
  }
}

module.exports = { CellDataActivationGroup };
