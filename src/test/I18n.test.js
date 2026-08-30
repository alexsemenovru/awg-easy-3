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
  const dynamicKeys = ['disabled', 'deleted', 'deleteConfirm', 'deletingClient',
    'deletedConnectionLost', 'duplicateName', 'passwordChanged', 'httpError',
    'online', 'offline', 'measuring', 'diagnosticsUnavailable', 'sampleSeconds'];
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

test('server rate labels and unconfirmed delivery warning have distinct translations in five languages', () => {
  const { i18n } = loadI18n();
  for (const key of ['serverSent', 'serverReceived', 'deliveryUnconfirmed']) {
    const translations = new Set();
    for (const language of ['en', 'ru', 'fa', 'es', 'zh-cn']) {
      i18n.setLanguage(language);
      const text = i18n.t(key);
      assert.notEqual(text, key);
      assert.ok(text.trim());
      translations.add(text);
    }
    assert.equal(translations.size, 5, `${key} must not silently fall back to English`);
  }
  i18n.setLanguage('ru');
  assert.equal(i18n.t('deliveryUnconfirmed'), 'Отправлено сервером; доставка не подтверждена.');
});

test('profile instructions explain manual copying while the button promises only to display the link', () => {
  const { i18n } = loadI18n();
  for (const [language, copyWord, button] of [
    ['en', 'copy', 'Show link'], ['ru', 'скопируйте', 'Показать ссылку'],
    ['es', 'copia', 'Mostrar enlace'], ['zh-cn', '复制', '显示链接'], ['fa', 'کپی', 'نمایش پیوند'],
  ]) {
    i18n.setLanguage(language);
    assert.ok(i18n.t('profileNote').includes(copyWord), `${language} must explain copying`);
    assert.equal(i18n.t('showProfileLink'), button);
  }
});
