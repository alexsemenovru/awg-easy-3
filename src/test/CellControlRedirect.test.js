'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CellControlRedirect, redirectSnapshot } = require('../lib/CellControlRedirect');

const value = () => ({ interfaceName: 'awgcellc0', ownerTag: 'awg-easy-3-cell:11111111-1111-4111-8111-111111111111',
  source4: '192.0.2.1', sourcePort: 53185, peer4: '203.0.113.1', peerPort: 53084, bridgePort: 49077 });
async function fixture(t, { verified = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-control-redirect-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let kernel = null;
  const calls = [];
  const runner = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'conntrack') return { stdout: '', stderr: '' };
    if (args.join(' ') === '-j list tables') return { stdout: JSON.stringify({ nftables: kernel ? [kernel.nftables[0]] : [] }) };
    if (args.join(' ') === '-j list table ip awg_easy_3_technical') return { stdout: JSON.stringify(kernel) };
    if (args[0] === '-c') return { stdout: '' };
    if (args[0] === '-j' && args[1] === '-f') {
      const batch = JSON.parse(await fs.readFile(args[2], 'utf8'));
      kernel = { nftables: batch.nftables.map(item => item.add) };
      return { stdout: '' };
    }
    if (args.join(' ') === 'delete table ip awg_easy_3_technical') { kernel = null; return { stdout: '' }; }
    throw new Error('Unexpected host command');
  };
  return { directory, calls, runner,
    redirect: new CellControlRedirect({ directory, verifyOwned: async () => verified, runner }),
    getKernel: () => kernel, setKernel: current => { kernel = current; } };
}

test('technical redirect matches only the owned original control UDP tuple and recovers to direct', async t => {
  const data = await fixture(t);
  await data.redirect.apply(value());
  assert.equal((await data.redirect.read()).phase, 'active');
  const text = JSON.stringify(data.getKernel());
  assert.match(text, /saddr.*192\.0\.2\.1/);
  assert.match(text, /sport.*53185/);
  assert.match(text, /dport.*53084/);
  assert.doesNotMatch(text, /masquerade|forward|flush/);
  await data.redirect.recover();
  assert.equal(await data.redirect.read(), null);
  assert.equal(data.getKernel(), null);
  const clears = data.calls.filter(call => call[0] === 'conntrack' && call[1] === '-D');
  assert.equal(clears.length, 2);
  for (const call of clears) assert.deepEqual(call.slice(1), ['-D', '-p', 'udp',
    '--orig-src', '192.0.2.1', '--orig-dst', '203.0.113.1', '--sport', '53185', '--dport', '53084']);
});

test('unproven AWG or an unowned or externally changed table is never changed', async t => {
  const unknown = await fixture(t, { verified: false });
  await assert.rejects(unknown.redirect.apply(value()), /ownership is unproven/);
  assert.equal(unknown.getKernel(), null);
  const foreign = await fixture(t);
  foreign.setKernel(redirectSnapshot(value()));
  await assert.rejects(foreign.redirect.recover(), /Unowned/);
  assert.ok(foreign.getKernel());
  const modified = await fixture(t);
  await modified.redirect.apply(value());
  modified.getKernel().nftables[2].rule.expr.push({ counter: { packets: 0, bytes: 0 } });
  await assert.rejects(modified.redirect.recover(), /changed externally/);
  assert.ok(modified.getKernel());
});

test('prepared journal recovers an apply that reached the kernel before interruption', async t => {
  const data = await fixture(t);
  const runner = async (file, args, options) => {
    const result = await data.runner(file, args, options);
    if (file === 'nft' && args[0] === '-j' && args[1] === '-f') throw new Error('Interrupted after apply');
    return result;
  };
  const interrupted = new CellControlRedirect({ directory: data.directory, verifyOwned: async () => true, runner });
  await assert.rejects(interrupted.apply(value()), /Interrupted/);
  assert.equal((await interrupted.read()).phase, 'prepared');
  assert.ok(data.getKernel());
  await data.redirect.recover();
  assert.equal(await data.redirect.read(), null);
  assert.equal(data.getKernel(), null);
});

test('missing conntrack cannot install a redirect with stale original flow state', async t => {
  const data = await fixture(t);
  const redirect = new CellControlRedirect({ directory: data.directory, verifyOwned: async () => true,
    runner: (file, args, options) => file === 'conntrack' ? Promise.reject(new Error('Not installed')) : data.runner(file, args, options) });
  await assert.rejects(redirect.apply(value()), /Not installed/);
  assert.equal(await redirect.read(), null);
  assert.equal(data.getKernel(), null);
});
