'use strict';

const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns/promises');
const crypto = require('node:crypto');
const { BackupJournal } = require('./BackupJournal');
const { CellControlRedirect, normalizeTechnicalNat } = require('./CellControlRedirect');
const { recoveryStoreFor } = require('./CellControlAuthority');
const { permanentPathFromPlan } = require('./CellAwgPermanentDeployment');
const { normalizeAwgConfig } = require('./CellAwgSnapshot');
const { runProcess } = require('./ProcessRunner');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const names = ['interfaceName', 'ownerTag', 'source4', 'sourcePort', 'peer4', 'peerPort', 'target4'];
function restoredContext(value) {
  if (!value || Object.keys(value).sort().join(',') !== [...names].sort().join(',')
    || !/^[A-Za-z0-9_.-]{1,15}$/.test(value.interfaceName)
    || !/^awg-easy-3-cell:[a-f0-9-]{36}$/.test(value.ownerTag)
    || ![4, 6].includes(net.isIP(value.peer4))
    || !['source4', 'target4'].every(key => net.isIP(value[key]) === net.isIP(value.peer4))
    || ![value.sourcePort, value.peerPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)
    || value.target4 === value.peer4) throw new Error('Invalid restored AWG endpoint tuple');
  return Object.fromEntries(names.map(name => [name, value[name]]));
}
function restoredSnapshot(input, table) {
  const value = restoredContext(input);
  const family = net.isIP(value.peer4) === 6 ? 'ip6' : 'ip';
  if (!['awg_easy_3_restore_control', 'awg_easy_3_restore_data'].includes(table)) throw new Error('Invalid restore NAT table');
  const match = (protocol, field, right) => ({ match: { op: '==', left: { payload: { protocol, field } }, right } });
  return { nftables: [
    { table: { family, name: table, comment: value.ownerTag } },
    // Technical CONTROL redirect at -100 wins while its bridge is active.
    // This rule never carries data traffic into the technical network.
    { chain: { family, table, name: 'output', type: 'nat', hook: 'output', prio: -90, policy: 'accept' } },
    { rule: { family, table, chain: 'output', comment: value.ownerTag, expr: [
      match(family, 'saddr', value.source4), match(family, 'daddr', value.peer4),
      match('udp', 'sport', value.sourcePort), match('udp', 'dport', value.peerPort),
      { dnat: { addr: value.target4 } },
    ] } },
  ] };
}

// Keep pinned AWG manifests/descriptors unchanged. Reverse conntrack NAT makes
// replies match their original peer endpoint; only a proof-authorized destination
// changes. An exact owned socket tuple, not all VPN/client UDP, is translated.
function createRestoredEndpoint({ stateDirectory, connectionStore, permanentPlanStore,
  dataDeployment, runner = runProcess, buildPath = permanentPathFromPlan,
  resolve = host => dns.lookup(host, { all: true }) }) {
  const resolved = family => new BackupJournal(path.join(stateDirectory, 'restored-endpoint', family === 6 ? 'resolved6.json' : 'resolved.json'), value => {
    if (!value || Object.keys(value).sort().join(',') !== 'address4,proofHash,version'
      || value.version !== 1 || !net.isIP(value.address4) || !/^[a-f0-9]{64}$/.test(value.proofHash)) {
      throw new Error('Invalid restored endpoint resolution');
    }
    return value;
  }, 1024);
  const target = async (family = 4) => {
    const connection = await connectionStore.read();
    const recovery = await recoveryStoreFor(connectionStore, connection)?.read();
    const host = recovery?.authority?.proof.endpointHost;
    if (!host) {
      if (connection.authorityGeneration) throw new Error('Pinned recovery endpoint proof is unavailable');
      return null;
    }
    if (net.isIP(host)) {
      if (net.isIP(host) !== family) throw new Error('Restore cannot change the pinned outer AWG address family');
      return host;
    }
    const proofHash = crypto.createHash('sha256').update(JSON.stringify(recovery.authority.proof)).digest('hex');
    const prior = await resolved(family).read();
    if (prior?.proofHash === proofHash && net.isIP(prior.address4) === family) return prior.address4;
    const answers = await resolve(host);
    const address = answers.find(row => row.family === family && net.isIP(row.address) === family)?.address;
    if (!address) throw new Error('Restored Main endpoint has no address in the pinned AWG family');
    await resolved(family).write({ version: 1, proofHash, address4: address });
    return address;
  };
  const endpointOf = plan => {
    if (!plan) return null;
    const parsed = normalizeAwgConfig(plan.spec.owner.config);
    const match = parsed.peers.length === 1 && (parsed.peers[0].endpoint?.match(/^\[([^\]]+)\]:(\d+)$/)
      || parsed.peers[0].endpoint?.match(/^([^:]+):(\d+)$/));
    if (!match || !net.isIP(match[1])) throw new Error('Pinned literal AWG endpoint required');
    return { address: match[1], port: Number(match[2]), family: net.isIP(match[1]) };
  };
  const socket = async (role, { recovering = false } = {}) => {
    const plan = role === 'control' ? await permanentPlanStore.read() : await dataDeployment.store.read();
    if (!plan) return null;
    const options = role === 'control' ? { stateDirectory: path.join(stateDirectory, 'permanent'), plan, runner }
      : { stateDirectory: dataDeployment.stateDirectory, plan, runner, policyTable: dataDeployment.policyTable,
        guardTable: dataDeployment.guardTable, retainGuard: true };
    const owned = buildPath(options);
    if (!await owned.verifyOwned()) throw new Error('Restored endpoint ownership is unproven');
    const peer = endpointOf(plan);
    const sourcePort = Number((await runner('awg', ['show', owned.interfaceName, 'listen-port'],
      { timeoutMs: 3000, maxOutputBytes: 128 })).stdout);
    const route = async address => {
      const rows = JSON.parse((await runner('ip', ['-j', `-${peer.family}`, 'route', 'get', address],
        { timeoutMs: 3000, maxOutputBytes: 4096 })).stdout);
      const source = rows.length === 1 && (rows[0].prefsrc || rows[0].src);
      if (net.isIP(source) !== peer.family || rows[0].dst !== address) throw new Error('AWG source route is unavailable');
      return source;
    };
    const source4 = await route(peer.address);
    const target4 = recovering ? null : await target(peer.family);
    if (!recovering && target4 && await route(target4) !== source4) {
      throw new Error('Restored AWG endpoint requires a different source route');
    }
    return { interfaceName: owned.interfaceName, ownerTag: plan.spec.owner.ownerTag,
      source4, sourcePort, peer4: peer.address, peerPort: peer.port, target4 };
  };
  const redirects = Object.fromEntries(['control', 'data'].map(role => {
    const table = `awg_easy_3_restore_${role}`;
    return [role, new CellControlRedirect({ directory: path.join(stateDirectory, 'restored-endpoint', role),
      table, validateContext: restoredContext, makeSnapshot: value => restoredSnapshot(value, table), runner,
      verifyOwned: async (value, { recovering }) => {
        const current = await socket(role, { recovering });
        return current && Object.entries(current).every(([key, expected]) =>
          recovering && ['source4', 'sourcePort', 'target4'].includes(key) || value[key] === expected);
      } })];
  }));
  return Object.freeze({ ensure: async ({ protect }) => {
    if (typeof protect !== 'function') throw new Error('User traffic guard required for endpoint migration');
    try {
    const control = endpointOf(await permanentPlanStore.read());
    const destination = await target(control?.family ?? 4);
    if (!destination) return { migrated: false };
    const changes = [];
    for (const role of ['control', 'data']) {
      const desired = await socket(role);
      const redirect = redirects[role];
      const saved = await redirect.read();
      const current = await redirect.current();
      if (!desired) {
        if (saved || current) throw new Error('Restore NAT exists without its owned AWG plan');
        continue;
      }
      if (desired.target4 === desired.peer4) {
        if (saved || current) changes.push({ redirect, desired: null });
      } else if (!saved || saved.phase !== 'active' || !same(saved.context, restoredContext(desired))
        || !current || normalizeTechnicalNat(current) !== normalizeTechnicalNat(restoredSnapshot(desired,
          `awg_easy_3_restore_${role}`))) changes.push({ redirect, desired });
    }
    if (changes.length) {
      await protect();
      for (const change of changes) {
        if (change.desired) await change.redirect.apply(change.desired);
        else await change.redirect.recover();
      }
    }
    return { migrated: true, changed: changes.length !== 0 };
    } catch (error) {
      await protect();
      throw error;
    }
  }, close: async ({ protect }) => {
    if (typeof protect !== 'function') throw new Error('User traffic guard required for endpoint cleanup');
    const active = [];
    for (const redirect of Object.values(redirects)) {
      if (await redirect.read() || await redirect.current()) active.push(redirect);
    }
    if (active.length) {
      await protect();
      for (const redirect of active) await redirect.recover();
    }
  } });
}
module.exports = { restoredContext, restoredSnapshot, createRestoredEndpoint };
