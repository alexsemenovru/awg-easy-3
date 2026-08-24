'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const www = path.join(__dirname, '..', 'www');
const html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(www, 'js', 'i18n.js'), 'utf8');

const loadI18n = () => {
  const documentElement = { lang: '', dir: '' };
  const context = {
    document: { documentElement, querySelectorAll: () => [] },
    window: {},
  };
  vm.runInNewContext(script, context);
  return { documentElement, i18n: context.window.awgI18n };
};

test('provides every interface string in all supported languages', () => {
  const markupKeys = [...html.matchAll(/data-i18n(?:-placeholder|-label|-alt)?="([^"]+)"/g)]
    .map((match) => match[1]);
  const dynamicKeys = ['disabled', 'deleted', 'copied', 'deleteConfirm', 'deletingClient',
    'deletedConnectionLost', 'duplicateName', 'passwordChanged', 'httpError'];
  const keys = [...new Set([...markupKeys, ...dynamicKeys])];
  const { i18n } = loadI18n();

  for (const language of ['en', 'ru', 'fa', 'es', 'zh-cn']) {
    i18n.setLanguage(language);
    for (const key of keys) assert.notEqual(i18n.t(key), key, `${language} is missing ${key}`);
  }
});

test('uses RTL only for Persian', () => {
  const { documentElement, i18n } = loadI18n();
  for (const language of ['en', 'ru', 'es', 'zh-cn']) {
    i18n.setLanguage(language);
    assert.equal(documentElement.dir, 'ltr');
  }
  i18n.setLanguage('fa');
  assert.equal(documentElement.dir, 'rtl');
});
