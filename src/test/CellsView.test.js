'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'cells.js'), 'utf8');
const element = () => ({ children: [], textContent: '', className: '',
  classList: { hidden: true, add() { this.hidden = true; },
    remove() { this.hidden = false; } },
  replaceChildren(...items) { this.children = [...items]; },
  append(...items) { this.children.push(...items); } });

test('Cell view hides missing data and never turns stale data into a false zero', () => {
  const context = { window: {}, document: { createElement: () => element() } };
  vm.runInNewContext(script, context);
  const node = element(), summary = element(), list = element();
  let pollerOptions;
  let started = 0, stopped = 0;
  const view = context.window.awgCells({ api: { cellsInfo() {} }, node, summary, list,
    translate: (key, values) => `${key}:${values?.count ?? ''}`,
    createPoller: options => { pollerOptions = options;
      return { start: () => { started++; }, stop: () => { stopped++; } }; } });
  view.start();
  assert.equal(started, 1);
  pollerOptions.onData({ state: 'ready', cells: [{ id: 'a'.repeat(32),
    status: 'consumed', phase: 'closed', settings: {
      desiredRevision: 2, confirmedRevision: 1 } }] });
  assert.equal(node.classList.hidden, false);
  assert.equal(summary.textContent, 'cellsCount:1');
  assert.equal(list.children[0].children[0].textContent, '#aaaaaaaa');
  pollerOptions.onData({ state: 'stale', cells: [] });
  assert.equal(summary.textContent, 'cellsStale:');
  assert.equal(list.children.length, 0);
  pollerOptions.onData({ state: 'unavailable', cells: [] });
  assert.equal(node.classList.hidden, true);
  view.stop();
  assert.equal(stopped, 1);
});

test('Cell invitation is shown only on request and cleared when dialog closes', async () => {
  const handlers = {};
  const button = { disabled: false, addEventListener: (event, handler) => { handlers[event] = handler; } };
  const status = element();
  const code = { value: '', focus() {} };
  const dialog = { open: false, addEventListener: (event, handler) => { dialog[event] = handler; },
    showModal() { this.open = true; }, close() { this.open = false; this['close'](); } };
  const node = { ...element(), querySelector: selector => ({ '#issue-cell': button,
    '#cells-action-status': status })[selector] };
  const context = { window: {}, document: { createElement: () => element(),
    querySelector: selector => ({ '#cell-invitation-dialog': dialog,
      '#cell-invitation-code': code })[selector] } };
  vm.runInNewContext(script, context);
  const view = context.window.awgCells({ api: { cellsInfo() {},
    issueCellInvitation: async () => ({ code: 'x'.repeat(40) }) }, node, summary: element(), list: element(),
  translate: key => key, createPoller: () => ({ start() {}, stop() {} }) });
  await handlers.click();
  assert.equal(dialog.open, true, status.textContent);
  assert.equal(code.value, 'x'.repeat(40));
  assert.equal(button.disabled, false);
  dialog.close();
  assert.equal(code.value, '');
  view.stop();
});

test('technical control status is explicit and stale observations never appear connected', () => {
  const context = { window: {}, document: { createElement: () => element() } };
  vm.runInNewContext(script, context);
  const list = element(); let poll;
  context.window.awgCells({ api: {}, node: element(), summary: element(), list,
    translate: key => key, createPoller: options => { poll = options; return { start() {}, stop() {} }; } });
  const sample = receivedAt => ({ state: 'ready', cells: [{ id: 'a'.repeat(32),
    status: 'consumed', phase: 'closed', control: { path: 'technical', receivedAt } }] });
  poll.onData(sample(Date.now()));
  assert.equal(list.children[0].children[2].children[0].textContent, 'cellsControlTechnical');
  assert.equal(list.children[0].children[2].children[1].textContent, 'cellsControlHint');
  poll.onData(sample(Date.now() - 120001));
  assert.equal(list.children[0].children[2].children[0].textContent, 'cellsControlUnknown');
});
