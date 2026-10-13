'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('client help is reachable by pointer, keyboard and touch without inline paragraphs', () => {
  const html = fs.readFileSync(path.join(__dirname, '../www/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../www/css/tooltips.css'), 'utf8');
  assert.match(html, /tooltips\.js\?v=/);
  assert.equal((html.match(/class="info-trigger"/g) || []).length, 3);
  assert.match(css, /focus-within/);
  assert.match(css, /hover:hover/);
  assert.match(css, /info-tip\[data-open\]/);
  assert.doesNotMatch(html, /<small data-i18n="homeDesc"/);
});

test('tooltip opens on click, stays inside viewport and closes on outside click or Escape', () => {
  const documentHandlers = {};
  const tipHandlers = {};
  const triggerHandlers = {};
  const attributes = {};
  const bubble = { id: '', style: {} };
  const trigger = {
    setAttribute: (name, value) => { attributes[name] = value; },
    addEventListener: (name, handler) => { triggerHandlers[name] = handler; },
  };
  const tip = {
    querySelector: (selector) => selector === '.info-trigger' ? trigger : bubble,
    getBoundingClientRect: () => ({ left: 500 }),
    addEventListener: (name, handler) => { tipHandlers[name] = handler; },
    setAttribute: (name, value) => { attributes[name] = value; },
    removeAttribute: (name) => { delete attributes[name]; },
  };
  const window = { innerWidth: 600 };
  const document = { addEventListener: (name, handler) => { documentHandlers[name] = handler; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../www/js/tooltips.js'), 'utf8'), { window, document });
  window.awgTooltips.attach({ querySelectorAll: () => [tip] });
  assert.equal(attributes['aria-describedby'], bubble.id);
  tipHandlers.mouseenter();
  assert.equal(bubble.style.left, '-200px');
  triggerHandlers.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(attributes['aria-expanded'], 'true');
  assert.ok(Object.hasOwn(attributes, 'data-open'));
  documentHandlers.keydown({ key: 'Escape' });
  assert.equal(attributes['aria-expanded'], 'false');
  triggerHandlers.click({ preventDefault() {}, stopPropagation() {} });
  documentHandlers.click({ target: { closest: () => null } });
  assert.equal(attributes['aria-expanded'], 'false');
});
