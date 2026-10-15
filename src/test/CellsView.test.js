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
