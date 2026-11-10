'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAwgOwnership } = require('../lib/CellAwgOwnership');
const { CellAwgLifecycle } = require('../lib/CellAwgLifecycle');
const config = `[Interface]\nPrivateKey = ${Buffer.alloc(32, 9).toString('base64')}\nListenPort = 54322\nJc = 3\n`;
async function fixture(t, userspaceCommand = 'amneziawg-go') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cell-life-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const spec = { version: 1, owner: createAwgOwnership({ interfaceName: 'cell0', config }), addresses: ['10.88.0.1/24', 'fd88::1/64'] };
  const kernel = { link: null, config: '', addresses: [], rpFilter: 0, validMark: 0, guard: false, calls: [], fail: null, blankReads: 0 };
  const opts = { journalPath: path.join(dir, 'lifecycle.json'), userspaceCommand, activateGuard: async names => {
    assert.deepEqual(names, ['cell0']); kernel.guard = true;
  }, runner: async (file, args) => {
    if (file === 'ip' && args[0] === '-d') return { stdout: JSON.stringify(kernel.link ? [kernel.link] : []) };
    if (file === 'ip' && args[0] === '-j') return { stdout: JSON.stringify([{ ifname: 'cell0', addr_info: kernel.addresses.map(cidr => {
      const [local, prefix] = cidr.split('/'); return { local, prefixlen: Number(prefix), family: local.includes(':') ? 'inet6' : 'inet', scope: 'global' };
    }) }]) };
    if (file === 'awg' && args[0] === 'showconf') {
      if (kernel.config === '[Interface]\n' && ++kernel.blankReads > 1) {
        if (kernel.fail === 'ephemeral-port') return { stdout: '[Interface]\nListenPort = 49155\n' };
        if (kernel.fail === 'changed-blank') return { stdout: '[Interface]\nListenPort = 49155\nH1 = 987\n' };
      }
      return { stdout: kernel.config };
    }
    if (file === 'sysctl' && args[0] === '-n') return { stdout: String(args[1].endsWith('/src_valid_mark') ? kernel.validMark : kernel.rpFilter) };
    assert.equal(kernel.guard, true); kernel.calls.push([file, ...args]);
    const state = JSON.parse(await fs.readFile(opts.journalPath, 'utf8'));
    assert.ok(['creating', 'removing', 'ready'].includes(state.phase));
    if (file === userspaceCommand) {
      assert.equal(state.phase, 'creating'); assert.equal(kernel.link, null);
      kernel.link = { ifname: 'cell0', mtu: 1420, flags: [], linkinfo: { info_kind: 'tun', info_data: { type: 'tun' } } };
      kernel.config = '[Interface]\n'; kernel.addresses = [];
      if (kernel.fail === 'after-create') throw new Error('process lost before tagging');
    } else if (file === 'sysctl') { if (args[1].endsWith('/src_valid_mark=1')) kernel.validMark = 1;
      else { assert.deepEqual(args, ['-w', 'net/ipv4/conf/cell0/rp_filter=2']); kernel.rpFilter = 2; }
    } else if (file === 'awg') {
      const text = await fs.readFile(args[2], 'utf8');
      kernel.config = kernel.fail === 'partial-config' ? text.replace('Jc = 3', 'Jc = 27') : text;
      if (kernel.fail === 'partial-config') throw new Error('partial apply');
    } else if (args[0] === 'address') {
      if (kernel.fail === 'second-address' && kernel.addresses.length === 1) throw new Error('interrupted address');
      kernel.addresses.push(args[2]);
    } else if (args.includes('alias')) {
      kernel.link.ifalias = args[args.indexOf('alias') + 1]; kernel.link.mtu = Number(args.at(-1));
      if (kernel.fail === 'after-tag') throw new Error('interrupted after tagging');
    } else if (args.includes('delete')) { kernel.link = null; kernel.config = ''; kernel.addresses = []; }
    else if (args.at(-1) === 'up') kernel.link.flags = ['UP'];
    else assert.fail('Unexpected lifecycle mutation');
    return { stdout: '' };
  } };
  return { dir, spec, kernel, life: new CellAwgLifecycle(opts), fresh: () => new CellAwgLifecycle(opts) };
}
test('userspace lifecycle journals creation before mutations, owns only its device and retains guard', async t => {
  const { life, spec, kernel, dir } = await fixture(t);
  assert.deepEqual(await life.create(spec), { ready: true, guarded: true });
  assert.equal((await life.load()).phase, 'ready'); assert.equal(kernel.link.ifalias, spec.owner.ownerTag);
  assert.deepEqual(kernel.addresses.sort(), spec.addresses); assert.equal(kernel.guard, true);
  assert.deepEqual(await fs.readdir(dir), ['lifecycle.json']);
});
test('Cell lifecycle can invoke the neutral bundled userspace command', async t => {
  const { life, spec, kernel } = await fixture(t, 'net-forward');
  await life.create(spec);
  assert.ok(kernel.calls.some(([file, name]) => file === 'net-forward' && name === 'cell0'));
});

test('asynchronous ephemeral binding cannot strand creation; other blank mutations remain refused', async t => {
  const f = await fixture(t); f.kernel.fail = 'ephemeral-port';
  assert.equal((await f.life.create(f.spec)).ready, true);
  const g = await fixture(t); g.kernel.fail = 'changed-blank';
  await assert.rejects(g.life.create(g.spec), /Unexpected partial AWG configuration/);
  assert.equal(g.kernel.guard, true);
});
test('already inherited loose rp_filter needs no write in a read-only sidecar', async t => {
  const { life, spec, kernel } = await fixture(t);
  kernel.rpFilter = 2; kernel.validMark = 1;
  await life.create(spec);
  assert.ok(!kernel.calls.some(([file]) => file === 'sysctl'));
  assert.equal((await life.load()).phase, 'ready');
});
test('userspace lifecycle never adopts existing same-name interface', async t => {
  const { life, spec, kernel } = await fixture(t); kernel.link = { ifname: 'cell0' };
  await assert.rejects(life.create(spec), /not be adopted/); assert.equal(kernel.calls.length, 0);
});
test('crash before alias refuses recovery instead of claiming an unproven TUN', async t => {
  const { life, fresh, spec, kernel } = await fixture(t); kernel.fail = 'after-create';
  await assert.rejects(life.create(spec), /command failed/); kernel.fail = null;
  const count = kernel.calls.length; await assert.rejects(fresh().recover(), /unproven/);
  assert.equal(kernel.calls.length, count); assert.equal((await life.load()).phase, 'creating');
});
test('tagged blank device and partially added addresses resume from durable creation intent', async t => {
  for (const failure of ['after-tag', 'second-address']) {
    const { life, fresh, spec, kernel } = await fixture(t); kernel.fail = failure;
    await assert.rejects(life.create(spec), /command failed/); kernel.fail = null;
    await fresh().recover(); assert.equal((await life.load()).phase, 'ready');
    assert.deepEqual(kernel.addresses.sort(), spec.addresses);
  }
});
test('unexplained partially configured device is not overwritten on recovery', async t => {
  const { life, fresh, spec, kernel } = await fixture(t); kernel.fail = 'partial-config';
  await assert.rejects(life.create(spec), /command failed/); kernel.fail = null;
  const count = kernel.calls.length; await assert.rejects(fresh().recover(), /partial/);
  assert.equal(kernel.calls.length, count); assert.equal(kernel.guard, true);
});
test('userspace lifecycle recreates missing confirmed device and restores proven down device', async t => {
  const { life, fresh, spec, kernel } = await fixture(t); await life.create(spec);
  kernel.link = null; await fresh().recover(); assert.equal(kernel.link.ifalias, spec.owner.ownerTag);
  kernel.link.flags = []; kernel.addresses = ['10.88.0.1/24'];
  await fresh().recover(); assert.deepEqual(kernel.link.flags, ['UP']);
  assert.deepEqual(kernel.addresses.sort(), spec.addresses);
});

test('missing address on a running device is drift, not silently repaired', async t => {
  const { life, fresh, spec, kernel } = await fixture(t); await life.create(spec);
  kernel.addresses = ['10.88.0.1/24']; const count = kernel.calls.length;
  await assert.rejects(fresh().recover(), /Missing owned AWG addresses/);
  assert.equal(kernel.calls.length, count); assert.equal(kernel.guard, true);
});
test('foreign addresses and changed configuration prevent removal', async t => {
  const { life, spec, kernel } = await fixture(t); await life.create(spec);
  kernel.addresses.push('10.99.0.1/24'); const count = kernel.calls.length;
  await assert.rejects(life.remove(), /Unexpected AWG addresses/); assert.equal(kernel.calls.length, count);
  kernel.addresses.pop(); kernel.config = kernel.config.replace('Jc = 3', 'Jc = 4');
  await assert.rejects(life.remove(), /changed/); assert.ok(kernel.link);
});
test('removal is journaled and recoverable after deletion before commit', async t => {
  const { life, fresh, spec, kernel } = await fixture(t); await life.create(spec);
  const save = life.save.bind(life);
  life.save = value => value.phase === 'empty' ? Promise.reject(new Error('disk full')) : save(value);
  await assert.rejects(life.remove(), /disk full/); assert.equal(kernel.link, null);
  assert.equal((await life.load()).phase, 'removing'); await fresh().recover();
  assert.equal((await life.load()).phase, 'empty'); assert.equal(kernel.guard, true);
});
test('invalid address specifications and corrupt journal fail without leaking private data', async t => {
  const { life, spec, dir, kernel } = await fixture(t);
  for (const addresses of [['bad'], ['10.0.0.1/99'], ['fd88::1/64', 'fd88::1/64'], ['fe80::1/64']]) {
    assert.throws(() => life.create({ ...spec, addresses }));
  }
  await fs.writeFile(path.join(dir, 'lifecycle.json'), '{"privateKey":"SECRET" BAD', { mode: 0o600 });
  await assert.rejects(life.recover(), e => !e.message.includes('SECRET') && /Unreadable/.test(e.message));
  assert.equal(kernel.calls.length, 0);
});
