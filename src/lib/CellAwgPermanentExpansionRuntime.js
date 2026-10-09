'use strict';

const { matchesAwgConfig } = require('./CellAwgSnapshot');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameConfig = (a, b) => matchesAwgConfig(a, b) && matchesAwgConfig(b, a);

// Caller holds the installation-wide lock. The revision journal is written
// BEFORE touching AWG/routes/nft. A failed expansion leaves the dedicated
// guard active; later resume() is the only automatic continuation.
class CellAwgPermanentExpansionRuntime {
  constructor({ deployment, revisionStore }) {
    if (!deployment || !deployment.store || typeof deployment.store.read !== 'function'
      || typeof deployment.buildPath !== 'function'
      || !revisionStore || !['read', 'prepare', 'commit'].every(name =>
        typeof revisionStore[name] === 'function')) {
      throw new TypeError('Invalid permanent AWG expansion runtime');
    }
    Object.assign(this, { deployment, revisionStore });
  }

  async base() {
    const plan = await this.deployment.store.read();
    if (!plan) throw new Error('Permanent AWG base plan is missing');
    return plan;
  }

  path(plan) {
    return this.deployment.buildPath({ stateDirectory: this.deployment.stateDirectory,
      plan, runner: this.deployment.runner });
  }

  async prepare(nextPlan) {
    const state = await this.revisionStore.read();
    if (state.pending) {
      if (!same(state.pending, nextPlan)) throw new Error('Another permanent AWG expansion is pending');
      return this.resume();
    }
    const previous = state.committed || await this.base();
    if (!await this.path(previous).verifyOperational()) {
      throw new Error('Current permanent AWG path is not operational');
    }
    await this.revisionStore.prepare(nextPlan);
    return this.resume();
  }

  async resume() {
    const state = await this.revisionStore.read();
    if (!state.pending) throw new Error('No pending permanent AWG expansion');
    const previous = state.committed || await this.base();
    const target = state.pending;
    const runtime = this.path(previous);
    const desired = this.path(target);
    const { lifecycle, awg, routes, firewall, guard } = runtime;
    if (!lifecycle || !['load', 'save', 'link', 'recover', 'verify'].every(name =>
      typeof lifecycle[name] === 'function')
      || !awg || typeof awg.apply !== 'function'
      || !routes || typeof routes.apply !== 'function'
      || !firewall || typeof firewall.apply !== 'function'
      || !guard || typeof guard.release !== 'function') {
      throw new TypeError('Permanent AWG expansion requires owned child transactions');
    }
    await runtime.protect();
    const link = await lifecycle.link(previous.spec.owner.interfaceName);
    if (link) await awg.recover();
    const beforeLife = await lifecycle.load();
    const beforeAwg = await awg.load();
    if (beforeLife.phase !== 'ready' || !beforeAwg.committed
      || beforeAwg.committed.ownerTag !== previous.spec.owner.ownerTag
      || ![previous, target].some(plan => sameConfig(plan.spec.owner.config,
        beforeAwg.committed.config))) {
      throw new Error('Permanent AWG expansion recovery identity differs from intent');
    }
    if (!sameConfig(beforeLife.spec.owner.config, beforeAwg.committed.config)) {
      await lifecycle.save({ ...beforeLife,
        spec: { ...beforeLife.spec, owner: beforeAwg.committed } });
    }
    await lifecycle.recover();
    if (!link) await awg.recover();
    await routes.recover();
    await firewall.recover();
    const life = await lifecycle.load();
    const awgState = await awg.load();
    if (life.phase !== 'ready' || awgState.pending !== null || !awgState.committed
      || life.spec.owner.ownerTag !== previous.spec.owner.ownerTag
      || awgState.committed.ownerTag !== previous.spec.owner.ownerTag
      || !same(life.spec.addresses, previous.spec.addresses)
      || ![previous, target].some(plan => sameConfig(plan.spec.owner.config,
        awgState.committed.config))
      || ![previous, target].some(plan => sameConfig(plan.spec.owner.config,
        life.spec.owner.config))) {
      throw new Error('Permanent AWG expansion ownership differs from intent');
    }
    const currentSpec = { ...life.spec, owner: awgState.committed };
    if (!(await lifecycle.verify(currentSpec)).up) {
      throw new Error('Permanent AWG interface is down during expansion');
    }
    if (!sameConfig(life.spec.owner.config, awgState.committed.config)) {
      await lifecycle.save({ ...life, spec: currentSpec });
    }
    if (!sameConfig(awgState.committed.config, target.spec.owner.config)) {
      await awg.apply(target.spec.owner);
    }
    const refreshed = await lifecycle.load();
    if (!sameConfig(refreshed.spec.owner.config, target.spec.owner.config)) {
      await lifecycle.save({ ...refreshed, spec: target.spec });
    }
    const routeState = await routes.load();
    if (!same(routeState.committed, target.routeCommands)) {
      await routes.apply(target.routeCommands);
    }
    const nftState = await firewall.load();
    if (!firewall.equal(nftState.committed, target.policy)) {
      await firewall.apply(target.policy);
    }
    if (!await desired.verifyOwned()) throw new Error('Expanded permanent AWG readback failed');
    await guard.release(() => desired.verifyOwned());
    if (!await desired.verifyOperational()) {
      throw new Error('Expanded permanent AWG path remains guarded');
    }
    await this.revisionStore.commit();
    return { ready: true, revision: state.revision + 1 };
  }

  async recoverCurrent() {
    const state = await this.revisionStore.read();
    if (state.pending) {
      await this.resume();
      const completed = await this.revisionStore.read();
      if (!completed.committed || completed.pending) {
        throw new Error('Permanent AWG expansion did not commit');
      }
      return completed.committed;
    }
    if (state.committed) {
      await this.path(state.committed).recover();
      return state.committed;
    }
    await this.deployment.resume();
    return this.base();
  }
}

module.exports = { CellAwgPermanentExpansionRuntime };
