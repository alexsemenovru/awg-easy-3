'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CellNftPolicyReceipt } = require('../lib/CellNftPolicyReceipt');

test('cell nft receipt detects changed kernel policy and never adopts an existing table', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-nft-receipt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let table = null;
  const runner = async (file, args, options) => {
    assert.equal(file, 'nft');
    if (args[2] === 'tables') return { stdout: JSON.stringify({ nftables: table
      ? [{ table: { family: 'inet', name: 'awg_easy_3' } }] : [] }) };
    assert.ok(options.maxOutputBytes >= 32 * 1024 * 1024);
    return { stdout: JSON.stringify(table) };
  };
  const receipt = new CellNftPolicyReceipt({
    filePath: path.join(directory, 'nft-receipt.json'), runner });
  assert.equal(await receipt.currentFingerprint(), null);
  await receipt.assertKnown();
  table = { nftables: [
    { table: { family: 'inet', name: 'awg_easy_3' } },
    { chain: { family: 'inet', table: 'awg_easy_3', name: 'forward',
      type: 'filter', hook: 'forward', prio: 0, policy: 'drop' } },
    { rule: { family: 'inet', table: 'awg_easy_3', chain: 'forward',
      expr: [{ accept: null }], handle: 17 } },
  ] };
  await assert.rejects(receipt.assertKnown(), /Foreign or changed/);
  await receipt.recordCurrent();
  await receipt.assertKnown();
  assert.equal(await receipt.matchesCurrent(), true);
  table.nftables[2].rule.handle = 82;
  assert.equal(await receipt.matchesCurrent(), true);
  table.nftables[2].rule.expr = [{ drop: null }];
  await assert.rejects(receipt.assertKnown(), /Foreign or changed/);
  assert.equal(await receipt.matchesCurrent(), false);
});

test('cell nft receipt rejects unsafe or corrupted saved state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-nft-receipt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'receipt.json');
  const receipt = new CellNftPolicyReceipt({ filePath, runner: async () => {
    throw new Error('unexpected kernel access'); } });
  await receipt.write('a'.repeat(64));
  await fs.writeFile(filePath, JSON.stringify({ version: 1, table: 'awg_easy_3',
    fingerprint: 'a'.repeat(64), extra: true }));
  await assert.rejects(receipt.read(), /Invalid cell nft receipt/);
  if (process.platform !== 'win32') {
    await fs.chmod(filePath, 0o644);
    await assert.rejects(receipt.read(), /Unsafe cell nft receipt/);
  }
});
