'use strict';
const { runProcess } = require('./ProcessRunner');
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
const canonical = rule => {
  const copy = structuredClone(rule);
  // nft reads a conntrack state-set match back as == rather than in.
  // Normalize only this equivalent spelling and unordered state membership.
  for (const item of copy.expr || []) {
    const m = item.match;
    if (m?.left?.ct?.key === 'state' && ['in','=='].includes(m.op)
      && Array.isArray(m.right?.set) && m.right.set.every(x => typeof x === 'string')) {
      m.op = '=='; m.right.set.sort();
    }
  }
  return stable(copy);
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const absent = e => e?.code === 1 || e?.exitCode === 1
  || (e?.code === 3 || e?.exitCode === 3) && /Table does not exist/.test(e.stderr || '');

// Called only after routing/lifecycle ownership verification, while its durable
// guard is still active. The earlier project nft hooks enforce all permissions;
// these narrow interface rules prevent Docker's later FORWARD=DROP override.
class CellDockerTransit {
  constructor({ runner = runProcess } = {}) { this.runner = runner; }
  async ensure(interfaces) {
    if (!Array.isArray(interfaces) || !interfaces.length || interfaces.length > 128
      || new Set(interfaces).size !== interfaces.length
      || interfaces.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_.-]{1,15}$/.test(n) || n === 'lo')) {
      throw new TypeError('Verified AWG interface set required');
    }
    for (const [family, suffix, binary] of [['ip', '4', 'iptables-legacy'], ['ip6', '6', 'ip6tables-legacy']]) {
      let snapshot = null;
      try { snapshot = JSON.parse((await this.runner('nft', ['-j', 'list', 'chain', family, 'filter', 'DOCKER-USER'])).stdout); }
      catch(e) { if (!absent(e)) throw e; }
      if (snapshot && !Array.isArray(snapshot.nftables)) throw new Error('Invalid Docker chain inventory');
      const batch = [];
      const wanted = [];
      for (const name of [...interfaces].sort()) for (const direction of ['iifname', 'oifname']) {
        const marker = `awg_easy_3_transit_${suffix}_${direction}_${name}`;
        const expr = [{ match: { op: '==', left: { meta: { key: direction } }, right: name } },
          ...(direction === 'oifname' ? [{ match: { op: 'in', left: { ct: { key: 'state' } },
            right: { set: ['established', 'related'] } } }] : []), { accept: null }];
        const rule = { family, table: 'filter', chain: 'DOCKER-USER', expr, comment: marker };
        wanted.push({ name, direction, marker });
        if (!snapshot) continue;
        const matches = snapshot.nftables.filter(x => x.rule?.comment === marker).map(x => {
          const copy = structuredClone(x.rule); delete copy.handle; return copy;
        });
        if (matches.length > 1 || matches.length === 1 && !same(matches[0], rule)) {
          throw new Error('Changed Docker transit rule; refusing mutation');
        }
        if (!matches.length) batch.push({ insert: { rule } });
      }
      if (batch.length) await this.runner('nft', ['-j', '-f', '-'], { input: JSON.stringify({ nftables: batch }) });
      // Older Docker engines can use legacy xtables independently of nft.
      let legacy, forward;
      try {
        legacy = (await this.runner(binary, ['-S', 'DOCKER-USER'])).stdout;
        forward = (await this.runner(binary, ['-S', 'FORWARD'])).stdout;
      }
      catch(e) { if (absent(e)) continue; throw e; }
      if (!legacy.includes('-N DOCKER-USER') || !forward.includes('-A FORWARD -j DOCKER-USER')) continue;
      for (const { name, direction, marker } of wanted) {
        const args = [direction === 'iifname' ? '-i' : '-o', name,
          ...(direction === 'oifname' ? ['-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED'] : []),
          '-m', 'comment', '--comment', marker, '-j', 'ACCEPT'];
        if (legacy.includes(marker)) {
          await this.runner(binary, ['-C', 'DOCKER-USER', ...args]);
        } else await this.runner(binary, ['-I', 'DOCKER-USER', '1', ...args]);
      }
    }
  }
}
module.exports = { CellDockerTransit };
