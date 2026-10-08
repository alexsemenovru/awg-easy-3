'use strict';
const net = require('node:net');
const { planCellTopology } = require('./CellTopology');
const { renderGeoIpPolicy } = require('./GeoIpPolicy');
const { ipNumber } = require('./GeoIpAddress');
const { routingPolicySnapshot } = require('./CellNftPolicyJson');
const TABLE = 'awg_easy_3_routes';
const iface = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(value)) throw new TypeError('Invalid routing interface');
  return value;
};
const integer = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;

// Pure compiler, deliberately separate from current local-only runtime. Commands
// are argv arrays, not shell strings; applying them requires an ownership-aware
// transaction. One AWG interface per direct link avoids overlapping AllowedIPs.
function compileCellRouting({ topology, nodeId, context, geoDatabase = {} }) {
  const plan = planCellTopology(topology).plans.find(p => p.node.id === nodeId);
  if (!plan || !context || typeof context.nat66 !== 'boolean') throw new TypeError('Invalid routing context');
  const client = iface(context.clientInterface), wan = iface(context.wanInterface);
  const names = new Set([client, wan]);
  if (names.size !== 2) throw new TypeError('Interfaces must be distinct');
  const links = new Map(), tables = new Set(), priorities = new Set();
  for (const link of plan.links) {
    const local = context.links?.[link.peer];
    if (!local || !integer(local.table, 52000, 52999) || !integer(local.priority, 20000, 20999)
      || tables.has(local.table) || priorities.has(local.priority)) throw new TypeError('Invalid owned routing allocation');
    const name = iface(local.interfaceName);
    if (names.has(name)) throw new TypeError('Interfaces must be distinct');
    names.add(name); tables.add(local.table); priorities.add(local.priority);
    links.set(link.peer, { ...link, ...local });
  }
  if (Object.keys(context.links || {}).some(k => !links.has(k))) throw new TypeError('Unknown routing link');
  const panel = context.panel;
  if (!panel || !integer(panel.port, 1, 65535) || net.isIP(panel.address4) !== 4
    || (panel.address6 !== undefined && (net.isIP(panel.address6) !== 6 || panel.address6.includes('%')))) {
    throw new TypeError('Invalid panel route');
  }
  const controller = topology.nodes.find(n => n.role === 'controller').id;
  const managed = `{ ${[...names].filter(n => n !== wan).map(n => `"${n}"`).join(', ')} }`;
  const enabled = (r, family) => r.enabled[`ipv${family}`] && r[`address${family}`];
  const pathTo = (id, family) => id === nodeId ? client : links.get(id)?.[`ipv${family}`] ? links.get(id).interfaceName : null;
  const home = plan.routes.filter(r => r.group === 'home');
  const input = [], forward = [], output = [], nat = [], geoRules = [], geoSets = new Map();
  const remoteHostDestinations = new Set();
  const geoDefinitions = new Map();
  const commands = [], rules = [], routeKeys = new Set();
  const route = (family, table, destination, dev, metric) => {
    const args = [`-${family}`, 'route', 'add', ...(destination === 'unreachable' ? ['unreachable', 'default'] : [destination]),
      'table', String(table), 'proto', '186', ...(dev ? ['dev', dev] : []), ...(metric ? ['metric', String(metric)] : [])];
    const key = JSON.stringify(args);
    if (!routeKeys.has(key)) { routeKeys.add(key); commands.push({ file: 'ip', args }); }
  };
  for (const family of [4, 6]) {
    const ip = family === 4 ? 'ip' : 'ip6', suffix = family === 4 ? 32 : 128;
    const panelAddress = panel[`address${family}`];
    if (panelAddress && plan.routes.some(r => r[`address${family}`]
      && ipNumber(r[`address${family}`]) === ipNumber(panelAddress))) throw new TypeError('Panel overlaps a client');
    // Exact host routes for reverse traffic. No default route in the host table.
    for (const r of plan.routes) {
      if (r.entry !== nodeId && enabled(r, family) && pathTo(r.entry, family)) {
        route(family, 'main', `${r[`address${family}`]}/${suffix}`, pathTo(r.entry, family));
        remoteHostDestinations.add(`${ip} daddr ${r[`address${family}`]} drop`);
      }
    }
    if (controller !== nodeId && panelAddress && pathTo(controller, family)) {
      route(family, 'main', `${panelAddress}/${suffix}`, pathTo(controller, family));
      remoteHostDestinations.add(`${ip} daddr ${panelAddress} drop`);
    }
    for (const link of links.values()) {
      // Permanent unreachable terminal: link deletion must never fall through to
      // the VPS default route. nft egress allowlist independently blocks leakage.
      route(family, link.table, 'unreachable', null, 32767);
      if (link[`ipv${family}`]) route(family, link.table, 'default', link.interfaceName, 100);
      for (const r of home) if (enabled(r, family) && pathTo(r.entry, family)) {
        route(family, link.table, `${r[`address${family}`]}/${suffix}`, pathTo(r.entry, family));
      }
      if (panelAddress && controller !== nodeId && pathTo(controller, family)) {
        route(family, link.table, `${panelAddress}/${suffix}`, pathTo(controller, family));
      }
    }
    for (const r of home) {
      if (!enabled(r, family) || !pathTo(r.entry, family)) continue;
      const source = r[`address${family}`], from = pathTo(r.entry, family);
      if (panelAddress) {
        if (nodeId === controller) {
          input.push(`iifname "${from}" ${ip} saddr ${source} ${ip} daddr ${panelAddress} tcp dport ${panel.port} accept`);
          output.push(`oifname "${from}" ${ip} daddr ${source} ct state established,related accept`);
        } else if (r.entry === nodeId && pathTo(controller, family)) {
          const to = pathTo(controller, family);
          forward.push(`iifname "${from}" oifname "${to}" ${ip} saddr ${source} ${ip} daddr ${panelAddress} tcp dport ${panel.port} accept`);
          forward.push(`iifname "${to}" oifname "${from}" ${ip} saddr ${panelAddress} ${ip} daddr ${source} ct state established,related accept`);
        }
      }
      for (const other of home) {
        if (other.id === r.id || !enabled(other, family) || !pathTo(other.entry, family)
          || (r.entry !== nodeId && other.entry !== nodeId)) continue;
        forward.push(`iifname "${from}" oifname "${pathTo(other.entry, family)}" ${ip} saddr ${source} ${ip} daddr ${other[`address${family}`]} accept`);
      }
    }
    // Home allowances precede this isolation barrier; neither Guest nor WAN-like
    // routing may reach another managed peer or panel via a remote exit.
    const addresses = plan.routes.map(r => r[`address${family}`]).filter(Boolean);
    if (addresses.length) {
      const elements = `{ ${addresses.join(', ')} }`;
      forward.push(`iifname ${managed} ${ip} saddr ${elements} ${ip} daddr ${elements} drop`);
      if (panelAddress) forward.push(`iifname ${managed} ${ip} saddr ${elements} ${ip} daddr ${panelAddress} drop`);
    }
    for (const r of plan.routes) {
      if (!enabled(r, family) || (r.entry !== nodeId && r.exit !== nodeId)) continue;
      const source = r[`address${family}`], from = pathTo(r.entry, family);
      const to = r.exit === nodeId ? wan : pathTo(r.exit, family);
      if (!from || !to) continue;
      const geo = renderGeoIpPolicy({ clients: [{ policy: r.geoPolicy, [`address${family}`]: source }],
        database: geoDatabase, awg: from, wan: to, active4: family === 4 ? [source] : [], active6: family === 6 ? [source] : [] });
      if (geo.sets) geoSets.set(geo.sets.match(/set (\w+)/)[1], geo.sets);
      for (const definition of geo.setDefinitions) geoDefinitions.set(definition.name, definition);
      if (geo.rules) geoRules.push(geo.rules);
      // Inserted after GeoIP below, not before filtering.
      rules.push(`iifname "${from}" oifname "${to}" ${ip} saddr ${source} accept`);
      rules.push(`iifname "${to}" oifname "${from}" ${ip} daddr ${source} ct state established,related accept`);
      if (r.exit === nodeId && (family === 4 || context.nat66)) {
        nat.push(`oifname "${wan}" ${ip} saddr ${source} masquerade`);
      }
      if (r.entry === nodeId && r.exit !== nodeId) {
        const link = links.get(r.exit);
        commands.push({ file: 'ip', args: [`-${family}`, 'rule', 'add', 'pref', String(link.priority),
          'iif', client, 'from', `${source}/${suffix}`, 'lookup', String(link.table)] });
      }
    }
  }
  const render = lines => lines.map(line => `    ${line}`).join('\n');
  const nftSnapshot = routingPolicySnapshot({ input: [...input, `iifname ${managed} drop`],
    forward: [...forward, ...geoRules.flatMap(r => r.split('\n')), ...rules, `iifname ${managed} drop`, `oifname ${managed} drop`],
    output: [...output, ...remoteHostDestinations, `oifname ${managed} drop`], nat, sets: [...geoDefinitions.values()] });
  return { plan, commands, table: TABLE,
    nftSnapshot,
    nftables: `# Managed by AWG-Easy 3 routing prototype\ntable inet ${TABLE} {\n${[...geoSets.values()].join('\n')}
  chain input { type filter hook input priority -15; policy accept;
${render(input)}
    iifname ${managed} drop
  }
  chain forward { type filter hook forward priority -15; policy accept;
${render(forward)}
${geoRules.join('\n')}
${render(rules)}
    iifname ${managed} drop
    oifname ${managed} drop
  }
  chain output { type filter hook output priority -15; policy accept;
${render(output)}
${render([...remoteHostDestinations])}
    oifname ${managed} drop
  }
  chain postrouting { type nat hook postrouting priority srcnat; policy accept;
${render(nat)}
  }
}\n` };
}
module.exports = { compileCellRouting };
