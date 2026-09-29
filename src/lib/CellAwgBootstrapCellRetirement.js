'use strict';

// Removes only the cell's own temporary registration path. The caller holds
// the installation-wide lock. Never retire a registered invitation until the
// permanent AWG path has been independently verified.
class CellAwgBootstrapCellRetirement {
  constructor({ connection, lifecycle, awg, firewall, routes, guard, interfaceName,
    verifyPermanent, now = Date.now }) {
    if (!connection || typeof connection.read !== 'function'
      || !lifecycle || !['load', 'recover', 'remove'].every(x => typeof lifecycle[x] === 'function')
      || !awg || !['load', 'retire'].every(x => typeof awg[x] === 'function')
      || !firewall || !['load', 'recover', 'apply', 'current', 'equal'].every(x => typeof firewall[x] === 'function')
      || firewall.table !== 'awg_easy_3_bootstrap'
      || !routes || !['load', 'recover', 'apply', 'inventory'].every(x => typeof routes[x] === 'function')
      || !guard || !['load', 'recover', 'protect', 'release'].every(x => typeof guard[x] === 'function')
      || guard.table !== 'awg_easy_3_bootstrap_guard'
      || !/^[a-zA-Z0-9_.-]{1,15}$/.test(interfaceName)
      || typeof verifyPermanent !== 'function' || typeof now !== 'function') {
      throw new TypeError('Invalid cell bootstrap retirement components');
    }
    Object.assign(this, { connection, lifecycle, awg, firewall, routes, guard,
      interfaceName, verifyPermanent, now });
  }

  async authorization() {
    const state = await this.connection.read();
    if (state?.status === 'registered') {
      if (!await this.verifyPermanent(state)) {
        throw new Error('Permanent cell AWG path is not verified');
      }
      return;
    }
    if (state?.status === 'pending' && state.invitation?.expiresAt <= this.now()) return;
    throw new Error('Temporary cell AWG path still needs registration');
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

  async empty() {
    const life = await this.lifecycle.load();
    const awg = await this.awg.load();
    const nft = await this.firewall.load();
    const routes = await this.routes.load();
    const inventory = await this.routes.inventory();
    // The route journal can be empty after an interrupted retirement. Do not
    // release the guard while a route or rule still names our temporary device.
    const sections = ['routes4', 'routes6', 'rules4', 'rules6'];
    if (sections.some(key => !Array.isArray(inventory[key])
      || inventory[key].some(row => !row || typeof row !== 'object'
        || row.dev === this.interfaceName || row.iif === this.interfaceName
        || row.iifname === this.interfaceName))) return false;
    return life.phase === 'empty' && awg.committed === null && awg.pending === null
      && nft.committed === null && nft.pending === null
      && this.firewall.equal(await this.firewall.current(), null)
      && routes.pending === null && routes.committed.length === 0;
  }

  async retire() {
    const saved = await this.lifecycle.load();
    if (saved.phase !== 'empty' && saved.spec?.owner.interfaceName !== this.interfaceName) {
      throw new Error('Cell bootstrap lifecycle belongs to another interface');
    }
    await this.authorization();
    await this.protect();
    // Recheck under the guard so a concurrent registration state change cannot
    // make a previously verified permanent path disappear unnoticed.
    await this.authorization();
    await this.firewall.recover();
    await this.firewall.apply(null);
    await this.routes.recover();
    await this.routes.apply([]);
    const current = await this.lifecycle.load();
    if (current.phase === 'ready') {
      await this.lifecycle.recover();
      await this.lifecycle.remove();
    } else if (current.phase === 'removing') await this.lifecycle.recover();
    else if (current.phase !== 'empty') throw new Error('Cell bootstrap creation requires recovery');
    await this.awg.retire();
    await this.guard.release(() => this.empty());
    return { retired: true };
  }
}

module.exports = { CellAwgBootstrapCellRetirement };
