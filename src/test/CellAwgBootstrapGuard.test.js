'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellRoutingGuard } = require('../lib/CellRoutingGuard');
const { routingGuardSnapshot } = require('../lib/CellNftOwnership');

test('bootstrap guard is independently owned and never releases a user routing guard', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-bootstrap-guard-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const userTable = 'awg_easy_3_routing_guard';
  const bootstrapTable = 'awg_easy_3_bootstrap_guard';
  const tables = new Map([[userTable, routingGuardSnapshot(['awg3'])]]);
  const runner = async (file, args, options) => {
    assert.equal(file, 'nft');
    if (args.includes('list')) {
      return { stdout: JSON.stringify(args.at(-1) === 'tables'
        ? { nftables: [...tables.values()].map(value => value.nftables[0]) }
        : tables.get(args.at(-1))) };
    }
    if (args.includes('-c')) return { stdout: '' };
    const batch = JSON.parse(await fs.readFile(args.at(-1), 'utf8')).nftables;
    const target = batch.find(item => item.add)?.add.table?.name || batch.find(item => item.delete)?.delete.table?.name;
    assert.equal(target, bootstrapTable);
    const objects = batch.filter(item => item.add).map(item => item.add);
    if (objects.length) tables.set(target, { nftables: objects });
    else tables.delete(target);
    return { stdout: '' };
  };
  const guard = new CellRoutingGuard({ journalPath: path.join(directory, 'bootstrap-guard.json'),
    table: bootstrapTable, runner });
  await guard.protect(['awg-enroll']);
  assert.deepEqual(tables.get(bootstrapTable), routingGuardSnapshot(['awg-enroll'], bootstrapTable));
  assert.deepEqual(tables.get(userTable), routingGuardSnapshot(['awg3']));
  await guard.release(async () => true);
  assert.equal(tables.has(bootstrapTable), false);
  assert.deepEqual(tables.get(userTable), routingGuardSnapshot(['awg3']));
});

test('bootstrap guard refuses a foreign same-name table', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-bootstrap-foreign-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const table = 'awg_easy_3_bootstrap_guard';
  const guard = new CellRoutingGuard({ journalPath: path.join(directory, 'guard.json'), table,
    runner: async (file, args) => ({ stdout: JSON.stringify(args.at(-1) === 'tables'
      ? { nftables: [{ table: { family: 'inet', name: table } }] }
      : routingGuardSnapshot(['foreign'], table)) }) });
  await assert.rejects(guard.protect(['awg-enroll']), /Foreign/);
});
