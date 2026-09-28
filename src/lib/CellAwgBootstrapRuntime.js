'use strict';

const { renderBootstrapServerConfig } = require('./CellAwgBootstrapConfig');
const { bootstrapPolicySnapshot } = require('./CellAwgBootstrapPolicy');
const { matchesAwgConfig } = require('./CellAwgSnapshot');

// Runs only after the dedicated device has been created, owned and journaled.
// The caller must hold the installation's cross-process lock. Child transactions
// and this coordinator retain the independent bootstrap guard on any failure.
class CellAwgBootstrapRuntime {
  constructor({ store, lifecycle, awg, firewall, guard, interfaceName,
    privateKey, listenPort, controllerAddress, registrationPort, profile,
    verifyPermanent }) {
    if (!store || typeof store.read !== 'function' || !lifecycle
      || !['load', 'save', 'verify'].every(name => typeof lifecycle[name] === 'function')
      || !awg || !['load', 'recover', 'apply', 'inspect'].every(name => typeof awg[name] === 'function')
      || !firewall || !['load', 'recover', 'apply', 'current', 'equal'].every(name => typeof firewall[name] === 'function')
      || firewall.table !== 'awg_easy_3_bootstrap'
      || !guard || !['load', 'recover', 'protect', 'release'].every(name => typeof guard[name] === 'function')
      || guard.table !== 'awg_easy_3_bootstrap_guard'
      || typeof verifyPermanent !== 'function') throw new TypeError('Invalid bootstrap runtime components');
    Object.assign(this, { store, lifecycle, awg, firewall, guard, interfaceName,
      privateKey, listenPort, controllerAddress, registrationPort, profile,
      verifyPermanentPath: verifyPermanent });
    // Validate immutable server parameters before any runtime operation.
    renderBootstrapServerConfig({ privateKey, listenPort, controllerAddress, profile, peers: [] });
    bootstrapPolicySnapshot({ interfaceName, controllerAddress, registrationPort, peers: [] });
  }

  async records() { return (await this.store.read()).invitations; }

  desired(records, owned) {
    const active = records.filter(item => ['preparing', 'ready'].includes(item.phase));
    const config = renderBootstrapServerConfig({ privateKey: this.privateKey,
      listenPort: this.listenPort, controllerAddress: this.controllerAddress,
      profile: this.profile, peers: active });
    const policy = bootstrapPolicySnapshot({ interfaceName: this.interfaceName,
      controllerAddress: this.controllerAddress, registrationPort: this.registrationPort,
      peers: records });
    return { spec: { ...owned, owner: { ...owned.owner, config } }, policy };
  }

  async ownership() {
    const saved = await this.lifecycle.load();
    if (saved.phase !== 'ready' || saved.spec?.owner.interfaceName !== this.interfaceName) {
      throw new Error('Dedicated bootstrap interface is not ready or owned');
    }
    const awgState = await this.awg.load();
    if (!awgState.committed || awgState.committed.interfaceName !== this.interfaceName
      || awgState.committed.ownerTag !== saved.spec.owner.ownerTag
      || awgState.committed.mtu !== saved.spec.owner.mtu) {
      throw new Error('Bootstrap AWG ownership journals disagree');
    }
    return { saved, awgState };
  }

  async verify(spec, policy) {
    const state = await this.lifecycle.verify(spec);
    if (!state.up) return false;
    await this.awg.inspect([spec.owner]);
    const firewallState = await this.firewall.load();
    return firewallState.pending === null && this.firewall.equal(firewallState.committed, policy)
      && this.firewall.equal(await this.firewall.current(), policy);
  }

  async reconcile(records, removing = false) {
    const existingGuard = await this.guard.load();
    if (existingGuard.interfaces.some(name => name !== this.interfaceName)
      || existingGuard.pending?.interfaces?.some(name => name !== this.interfaceName)) {
      throw new Error('Unrelated bootstrap guard cannot be released');
    }
    await this.guard.recover();
    await this.guard.protect([this.interfaceName]);
    // A pending child transaction is rolled back under the active guard before
    // deriving the new desired state from the durable invitation journal.
    await this.awg.recover();
    await this.firewall.recover();
    const { saved } = await this.ownership();
    const current = await this.awg.load();
    const currentSpec = { ...saved.spec, owner: current.committed };
    await this.lifecycle.verify(currentSpec);
    if (!matchesAwgConfig(saved.spec.owner.config, current.committed.config)) {
      await this.lifecycle.save({ ...saved, spec: currentSpec });
    }
    const { spec, policy } = this.desired(records, currentSpec);
    // On removal, stop admitting the peer before deleting it from AWG. On
    // addition, install the peer under a blanket guard before opening TCP.
    if (removing) await this.firewall.apply(policy);
    if (!matchesAwgConfig(current.committed.config, spec.owner.config)) {
      await this.awg.apply(spec.owner);
      await this.lifecycle.save({ ...saved, spec });
    }
    if (!removing) await this.firewall.apply(policy);
    if (!await this.verify(spec, policy)) throw new Error('Bootstrap runtime readback failed');
    await this.guard.release(() => this.verify(spec, policy));
  }

  async installPeer(record) {
    const records = await this.records();
    if (!records.some(item => item.id === record.id && item.phase === 'preparing'
      && item.temporaryPublicKey === record.temporaryPublicKey)) {
      throw new Error('Bootstrap peer has no preparing reservation');
    }
    await this.reconcile(records);
  }

  async verifyPeer(record) {
    const records = await this.records();
    if (!records.some(item => item.id === record.id && ['preparing', 'ready'].includes(item.phase)
      && item.temporaryPublicKey === record.temporaryPublicKey)) return false;
    const { saved } = await this.ownership();
    const { spec, policy } = this.desired(records, saved.spec);
    return this.verify(spec, policy);
  }

  async removePeer(record) {
    const records = await this.records();
    if (!records.some(item => item.id === record.id && item.phase === 'closing'
      && item.temporaryPublicKey === record.temporaryPublicKey)) {
      throw new Error('Bootstrap peer removal requires closing intent');
    }
    await this.reconcile(records, true);
  }

  async recover() {
    const records = await this.records();
    if (records.some(item => ['preparing', 'closing'].includes(item.phase))) {
      throw new Error('Recover invitation journal before bootstrap runtime');
    }
    // Conservative order: close the firewall to any no-longer-authorized
    // address before reconciling AWG, even if the current child state is stale.
    await this.reconcile(records, true);
  }

  verifyPermanent(record) { return this.verifyPermanentPath(record); }
}

module.exports = { CellAwgBootstrapRuntime };
