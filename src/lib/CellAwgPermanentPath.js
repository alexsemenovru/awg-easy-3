'use strict';

const { specification } = require('./CellAwgLifecycle');
const { manifest, planRouteChanges } = require('./CellRouteOwnership');
const { matchesAwgConfig } = require('./CellAwgSnapshot');

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Owns only the permanent inter-server AWG path. The caller holds the
// installation-wide process lock and supplies a trusted, persisted plan.
// This component does not attest a handshake or retire a temporary invitation.
class CellAwgPermanentPath {
  constructor({ lifecycle, awg, routes, firewall, guard, spec, policy, routeCommands }) {
    if (!lifecycle || !['load', 'create', 'recover', 'verify'].every(name => typeof lifecycle[name] === 'function')
      || !awg || !['load', 'initialize', 'recover', 'inspect'].every(name => typeof awg[name] === 'function')
      || !routes || !['load', 'apply', 'recover', 'inventory'].every(name => typeof routes[name] === 'function')
      || !firewall || !['load', 'apply', 'recover', 'current', 'equal', 'normalize'].every(name => typeof firewall[name] === 'function')
      || !guard || !['load', 'recover', 'protect', 'release'].every(name => typeof guard[name] === 'function')
      || !Array.isArray(routeCommands) || !policy) {
      throw new TypeError('Permanent AWG path dependencies required');
    }
    this.spec = specification(spec);
    if (!this.spec.owner.config || !this.spec.owner.interfaceName) {
      throw new TypeError('Permanent AWG identity required');
    }
    Object.assign(this, { lifecycle, awg, routes, firewall, guard,
      policy: firewall.normalize(policy), routeCommands: manifest(routeCommands).map(item => item.command) });
    this.interfaceName = this.spec.owner.interfaceName;
  }

  async protect() {
    const state = await this.guard.load();
    if (state.interfaces.some(name => name !== this.interfaceName)
      || state.pending?.interfaces?.some(name => name !== this.interfaceName)) {
      throw new Error('Unrelated permanent AWG guard cannot be released');
    }
    await this.guard.recover();
    await this.guard.protect([this.interfaceName]);
  }

  async verifyOwned() {
    const life = await this.lifecycle.load();
    if (life.phase !== 'ready' || !same(life.spec, this.spec)
      || !(await this.lifecycle.verify(this.spec)).up) return false;
    const awg = await this.awg.load();
    if (awg.pending !== null || !awg.committed
      || awg.committed.interfaceName !== this.interfaceName
      || awg.committed.ownerTag !== this.spec.owner.ownerTag
      || awg.committed.mtu !== this.spec.owner.mtu
      || !matchesAwgConfig(this.spec.owner.config, awg.committed.config)) return false;
    await this.awg.inspect([this.spec.owner]);
    const routes = await this.routes.load();
    if (routes.pending !== null || !same(routes.committed, this.routeCommands)) return false;
    const routeReadback = planRouteChanges({ previous: this.routeCommands,
      desired: this.routeCommands, inventory: await this.routes.inventory() });
    if (routeReadback.add.length || routeReadback.remove.length) return false;
    const firewall = await this.firewall.load();
    return firewall.pending === null && this.firewall.equal(firewall.committed, this.policy)
      && this.firewall.equal(await this.firewall.current(), this.policy);
  }

  async finish() {
    await this.lifecycle.recover();
    const awg = await this.awg.load();
    if (awg.committed === null && awg.pending === null) await this.awg.initialize(this.spec.owner);
    else {
      if (!awg.committed || awg.committed.interfaceName !== this.interfaceName
        || awg.committed.ownerTag !== this.spec.owner.ownerTag
        || awg.committed.mtu !== this.spec.owner.mtu
        || !matchesAwgConfig(this.spec.owner.config, awg.committed.config)) {
        throw new Error('Permanent AWG ownership differs from plan');
      }
      await this.awg.recover();
    }
    await this.routes.recover();
    const routes = await this.routes.load();
    if (!same(routes.committed, this.routeCommands)) {
      if (routes.committed.length) throw new Error('Permanent AWG routes differ from plan');
      await this.routes.apply(this.routeCommands);
    }
    await this.firewall.recover();
    const firewall = await this.firewall.load();
    if (!this.firewall.equal(firewall.committed, this.policy)) {
      if (firewall.committed !== null) throw new Error('Permanent AWG firewall differs from plan');
      await this.firewall.apply(this.policy);
    }
    if (!await this.verifyOwned()) throw new Error('Permanent AWG path readback failed');
    await this.guard.release(() => this.verifyOwned());
    return { ready: true };
  }

  async assertFresh() {
    const awg = await this.awg.load();
    const routes = await this.routes.load();
    const firewall = await this.firewall.load();
    if (awg.committed !== null || awg.pending !== null
      || routes.committed.length || routes.pending !== null
      || firewall.committed !== null || firewall.pending !== null
      || await this.firewall.current() !== null) {
      throw new Error('Permanent AWG path already has owned or foreign child state');
    }
    // Identical kernel routes are still foreign without our private journal.
    planRouteChanges({ previous: [], desired: this.routeCommands,
      inventory: await this.routes.inventory() });
  }

  async initialize() {
    if ((await this.lifecycle.load()).phase !== 'empty') {
      throw new Error('Existing permanent AWG path requires recovery');
    }
    await this.assertFresh();
    await this.protect();
    await this.lifecycle.create(this.spec);
    return this.finish();
  }

  async recover() {
    const saved = await this.lifecycle.load();
    if (!['creating', 'ready'].includes(saved.phase) || !same(saved.spec, this.spec)) {
      throw new Error('Permanent AWG lifecycle differs from plan');
    }
    await this.protect();
    return this.finish();
  }
}

module.exports = { CellAwgPermanentPath };
