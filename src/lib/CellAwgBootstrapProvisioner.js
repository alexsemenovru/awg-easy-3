'use strict';

const { specification } = require('./CellAwgLifecycle');
const { bootstrapPolicySnapshot } = require('./CellAwgBootstrapPolicy');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const net = require('node:net');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// First-install/recovery only. Never use this to update an interface with live
// invitations. The installation's external process lock is required.
class CellAwgBootstrapProvisioner {
  constructor({ store, lifecycle, awg, firewall, guard,
    interfaceName, controllerAddress, registrationPort }) {
    if (!store || typeof store.read !== 'function'
      || !lifecycle || !['load', 'create', 'recover', 'verify'].every(x => typeof lifecycle[x] === 'function')
      || !awg || !['load', 'initialize', 'recover', 'inspect'].every(x => typeof awg[x] === 'function')
      || !firewall || !['load', 'recover', 'apply', 'current', 'equal'].every(x => typeof firewall[x] === 'function')
      || firewall.table !== 'awg_easy_3_bootstrap'
      || !guard || !['load', 'recover', 'protect', 'release'].every(x => typeof guard[x] === 'function')
      || guard.table !== 'awg_easy_3_bootstrap_guard') {
      throw new TypeError('Invalid bootstrap provisioner components');
    }
    const baseline = bootstrapPolicySnapshot({ interfaceName, controllerAddress,
      registrationPort, peers: [] });
    Object.assign(this, { store, lifecycle, awg, firewall, guard,
      interfaceName, controllerAddress, baseline });
  }

  async requireNoInvitations() {
    const records = (await this.store.read()).invitations;
    if (records.some(item => item.phase !== 'closed')) {
      throw new Error('Provisioner cannot run with live invitations');
    }
  }

  async protect() {
    const state = await this.guard.load();
    if (state.interfaces.some(name => name !== this.interfaceName)
      || state.pending?.interfaces?.some(name => name !== this.interfaceName)) {
      throw new Error('Unrelated bootstrap guard cannot be released');
    }
    await this.guard.recover();
    await this.guard.protect([this.interfaceName]);
  }

  assertInitialSpec(spec) {
    const hostPrefix = net.isIP(this.controllerAddress) === 4 ? 32 : 128;
    if (spec.owner.interfaceName !== this.interfaceName
      || !same(spec.addresses, [`${this.controllerAddress}/${hostPrefix}`])
      || normalizeAwgConfig(spec.owner.config).peers.length !== 0) {
      throw new Error('Bootstrap initial device must have its own address and no peers');
    }
  }

  async finish(spec) {
    this.assertInitialSpec(spec);
    let life = await this.lifecycle.load();
    if (!['creating', 'ready'].includes(life.phase) || !same(life.spec, spec)) {
      throw new Error('Bootstrap lifecycle differs from provisioned identity');
    }
    await this.lifecycle.recover();
    life = await this.lifecycle.load();
    if (life.phase !== 'ready' || !same(life.spec, spec)) {
      throw new Error('Bootstrap interface was not recovered');
    }
    const awgState = await this.awg.load();
    if (awgState.committed === null && awgState.pending === null) {
      await this.awg.initialize(spec.owner);
    } else {
      if (!awgState.committed || !same(awgState.committed, spec.owner)) {
        throw new Error('Bootstrap AWG journal differs from initial identity');
      }
      await this.awg.recover();
    }
    await this.firewall.recover();
    const nftState = await this.firewall.load();
    if (nftState.committed !== null && !this.firewall.equal(nftState.committed, this.baseline)) {
      throw new Error('Bootstrap policy already contains invitation rules');
    }
    if (nftState.committed === null) await this.firewall.apply(this.baseline);
    await this.guard.release(async () => {
      if (!(await this.lifecycle.verify(spec)).up) return false;
      await this.awg.inspect([spec.owner]);
      const current = await this.firewall.load();
      return current.pending === null && this.firewall.equal(current.committed, this.baseline)
        && this.firewall.equal(await this.firewall.current(), this.baseline);
    });
    return { ready: true };
  }

  async initialize(input) {
    const spec = specification(input);
    this.assertInitialSpec(spec);
    await this.requireNoInvitations();
    if ((await this.lifecycle.load()).phase !== 'empty') throw new Error('Existing bootstrap lifecycle requires recovery');
    await this.protect();
    await this.lifecycle.create(spec);
    return this.finish(spec);
  }

  async recover() {
    await this.requireNoInvitations();
    const saved = await this.lifecycle.load();
    if (!['creating', 'ready'].includes(saved.phase)) {
      throw new Error('No journaled bootstrap device to recover');
    }
    if (saved.spec.owner.interfaceName !== this.interfaceName) {
      throw new Error('Bootstrap lifecycle belongs to another interface');
    }
    await this.protect();
    this.assertInitialSpec(saved.spec);
    return this.finish(saved.spec);
  }
}

module.exports = { CellAwgBootstrapProvisioner };
