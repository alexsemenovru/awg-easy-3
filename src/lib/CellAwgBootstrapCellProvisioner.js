'use strict';

const net = require('node:net');
const { specification } = require('./CellAwgLifecycle');
const { bootstrapClientPolicySnapshot } = require('./CellAwgBootstrapClientPolicy');
const { bootstrapCellRoutes } = require('./CellAwgBootstrapRoutes');
const { planRouteChanges } = require('./CellRouteOwnership');
const { prepareBootstrapCellDevice } = require('./CellAwgBootstrapCellDevice');
const { renderBootstrapCellConfig } = require('./CellAwgBootstrapConfig');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The caller holds the installation-wide process lock. The temporary AWG
// device, firewall and host route have independent journals. Only this
// coordinator may release the separate bootstrap guard after full readback.
class CellAwgBootstrapCellProvisioner {
  constructor({ connection, lifecycle, awg, firewall, routes, guard,
    interfaceName, prepare = prepareBootstrapCellDevice }) {
    if (!connection || typeof connection.read !== 'function'
      || !lifecycle || !['load', 'create', 'recover', 'verify'].every(x => typeof lifecycle[x] === 'function')
      || !awg || !['load', 'initialize', 'recover', 'inspect'].every(x => typeof awg[x] === 'function')
      || !firewall || !['load', 'recover', 'apply', 'current', 'equal'].every(x => typeof firewall[x] === 'function')
      || firewall.table !== 'awg_easy_3_bootstrap'
      || !routes || !['load', 'recover', 'apply', 'inventory'].every(x => typeof routes[x] === 'function')
      || !guard || !['load', 'recover', 'protect', 'release'].every(x => typeof guard[x] === 'function')
      || guard.table !== 'awg_easy_3_bootstrap_guard'
      || typeof prepare !== 'function' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(interfaceName)) {
      throw new TypeError('Invalid cell bootstrap provisioner components');
    }
    Object.assign(this, { connection, lifecycle, awg, firewall, routes, guard,
      interfaceName, prepare });
  }

  async pending() {
    const state = await this.connection.read();
    if (!state || state.status !== 'pending' || !state.invitation) {
      throw new Error('Pending cell AWG invitation required');
    }
    return state.invitation;
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

  assertInvitationSpec(spec, invitation) {
    const code = Buffer.from(JSON.stringify(invitation)).toString('base64url');
    const expected = renderBootstrapCellConfig(code, 0);
    if (spec.owner.interfaceName !== this.interfaceName
      || !same(spec.addresses, [expected.address])) {
      throw new Error('Cell bootstrap address differs from invitation');
    }
    const actual = normalizeAwgConfig(spec.owner.config);
    const requested = normalizeAwgConfig(expected.config.replace(/^Endpoint = .*\n/m, ''));
    if (actual.peers.length !== 1 || !actual.peers[0].endpoint) {
      throw new Error('Cell bootstrap endpoint is missing');
    }
    const endpoint = actual.peers[0].endpoint;
    delete actual.peers[0].endpoint;
    if (!same(actual, requested)) throw new Error('Cell bootstrap AWG identity differs from invitation');
    const match = endpoint.match(/^\[([^\]]+)\]:(\d+)$/) || endpoint.match(/^([^:]+):(\d+)$/);
    if (!match || !net.isIP(match[1]) || Number(match[2]) !== invitation.endpointPort
      || (net.isIP(invitation.endpointHost) && match[1] !== invitation.endpointHost)) {
      throw new Error('Cell bootstrap endpoint differs from invitation');
    }
  }

  async finish(spec, invitation) {
    this.assertInvitationSpec(spec, invitation);
    let life = await this.lifecycle.load();
    if (!['creating', 'ready'].includes(life.phase) || !same(life.spec, spec)) {
      throw new Error('Cell bootstrap lifecycle differs from invitation');
    }
    await this.lifecycle.recover();
    life = await this.lifecycle.load();
    if (life.phase !== 'ready' || !same(life.spec, spec)) {
      throw new Error('Cell bootstrap interface was not recovered');
    }
    const awgState = await this.awg.load();
    if (awgState.committed === null && awgState.pending === null) {
      await this.awg.initialize(spec.owner);
    } else {
      if (!awgState.committed || !same(awgState.committed, spec.owner)) {
        throw new Error('Cell bootstrap AWG journal differs from invitation');
      }
      await this.awg.recover();
    }
    const policy = bootstrapClientPolicySnapshot({ interfaceName: this.interfaceName,
      cellAddress: invitation.cellAddress, controllerAddress: invitation.controllerAddress,
      registrationPort: invitation.registrationPort });
    const commands = bootstrapCellRoutes({ interfaceName: this.interfaceName,
      cellAddress: invitation.cellAddress, controllerAddress: invitation.controllerAddress });
    await this.routes.recover();
    const routeState = await this.routes.load();
    if (routeState.committed.length && !same(routeState.committed, commands)) {
      throw new Error('Cell bootstrap route journal differs from invitation');
    }
    if (!routeState.committed.length) await this.routes.apply(commands);
    await this.firewall.recover();
    const nftState = await this.firewall.load();
    if (nftState.committed !== null && !this.firewall.equal(nftState.committed, policy)) {
      throw new Error('Cell bootstrap policy differs from invitation');
    }
    if (nftState.committed === null) await this.firewall.apply(policy);
    await this.guard.release(async () => {
      if (!(await this.lifecycle.verify(spec)).up) return false;
      await this.awg.inspect([spec.owner]);
      const routeReadback = await this.routes.load();
      if (routeReadback.pending !== null || !same(routeReadback.committed, commands)) return false;
      const plan = planRouteChanges({ previous: commands, desired: commands,
        inventory: await this.routes.inventory() });
      if (plan.add.length || plan.remove.length) return false;
      const current = await this.firewall.load();
      return current.pending === null && this.firewall.equal(current.committed, policy)
        && this.firewall.equal(await this.firewall.current(), policy);
    });
    return { ready: true };
  }

  async initialize(code) {
    const invitation = await this.pending();
    const encoded = Buffer.from(JSON.stringify(invitation)).toString('base64url');
    if (code !== encoded) throw new Error('Cell bootstrap code differs from pending invitation');
    const prepared = await this.prepare({ code, interfaceName: this.interfaceName });
    const spec = specification(prepared.spec);
    if (prepared.controllerAddress !== invitation.controllerAddress
      || prepared.registrationPort !== invitation.registrationPort
      || !same(spec.addresses, [`${invitation.cellAddress}/${invitation.cellAddress.includes(':') ? 128 : 32}`])) {
      throw new Error('Prepared cell bootstrap identity differs from invitation');
    }
    this.assertInvitationSpec(spec, invitation);
    if ((await this.lifecycle.load()).phase !== 'empty') {
      throw new Error('Existing cell bootstrap lifecycle requires recovery');
    }
    await this.protect();
    await this.lifecycle.create(spec);
    return this.finish(spec, invitation);
  }

  async recover() {
    const invitation = await this.pending();
    const saved = await this.lifecycle.load();
    if (!['creating', 'ready'].includes(saved.phase)
      || saved.spec.owner.interfaceName !== this.interfaceName) {
      throw new Error('No owned cell bootstrap device to recover');
    }
    // DNS need not resolve again: recovery uses the exact previously journaled
    // endpoint and configuration, but it must still match the pending code.
    await this.protect();
    return this.finish(specification(saved.spec), invitation);
  }
}

module.exports = { CellAwgBootstrapCellProvisioner };
