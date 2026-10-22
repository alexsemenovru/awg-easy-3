'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Small DOM fixture for the actual app script; native details/layout are also
// exercised in the synthetic browser preview, without touching a live VPN.
const setup = async ({ mode = 'password' } = {}) => {
  let document;
  const element = (selector = '') => {
    const classes = new Set();
    const value = {
      dataset: {}, checked: false, disabled: false, open: false, textContent: '',
      handlers: {}, classList: {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      },
      addEventListener: (name, handler) => { value.handlers[name] = handler; },
      setAttribute: (name, content) => { value[name] = content; },
      replaceChildren: () => {}, reset: () => {},
      matches: (candidate) => candidate === selector,
      focus: () => { document.activeElement = value; },
    };
    return value;
  };
  const makeCard = () => {
    const card = element();
    const fields = new Map();
    card.querySelector = (selector) => {
      if (!fields.has(selector)) fields.set(selector, element(selector));
      return fields.get(selector);
    };
    card.querySelectorAll = () => [];
    return card;
  };
  const container = element();
  container.cards = [];
  container.replaceChildren = (...cards) => { container.cards = cards; };
  container.querySelector = (selector) => container.cards.find((card) =>
    selector === `[data-client-id="${card.dataset.clientId}"]`);
  container.querySelectorAll = (selector) => selector === '.client-card' ? container.cards
    : container.cards.flatMap((card) => ['.group-toggle', '.ipv4-toggle', '.ipv6-toggle']
      .map((control) => card.querySelector(control)));
  const nodes = new Map([
    ['#clients', container],
    ['#client-template', { content: { firstElementChild: { cloneNode: makeCard } } }],
  ]);
  document = {
    hidden: false, activeElement: null, addEventListener: () => {}, querySelectorAll: () => [],
    querySelector: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, element(selector));
      return nodes.get(selector);
    },
  };
  let rows = ['a', 'b'].map((id) => ({ id, name: id, address4: `10.8.0.${id === 'a' ? 2 : 3}`,
    address6: `fd00::${id === 'a' ? 2 : 3}`, networkGroup: 'home', enabled: true,
    ipv4Enabled: true, ipv6Enabled: true, ipv6Available: true }));
  let failure;
  let loginFailure;
  let refreshFailure = false;
  let passwordChangeFailure;
  const calls = [];
  const loginInputs = [];
  const api = {
    session: async () => ({ authenticated: true, language: 'en', authMode: mode }),
    login: async (password, code) => { loginInputs.push({ password, code });
      if (loginFailure) throw loginFailure; },
    changePassword: async () => { if (passwordChangeFailure) throw passwordChangeFailure; },
    clients: async () => { if (refreshFailure) throw new Error('Refresh failed'); return rows.map((row) => ({ ...row })); },
    network: async () => ({}),
    updateClient: async (id, changes) => {
      calls.push({ id, changes: { ...changes } });
      if (failure) throw failure;
      rows = rows.map((row) => {
        if (row.id !== id) return row;
        const next = { ...row, ...changes };
        next.enabled = next.ipv4Enabled || next.ipv6Enabled;
        return next;
      });
      return { ...rows.find((row) => row.id === id) };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../www/js/app.js'), 'utf8'), {
    window: { addEventListener: () => {},
      awgConnection: ({ load, onSession }) => ({ start: () => load().then(onSession), retry() {}, stop() {} }),
      awgApi: api, awgI18n: { t: (key) => key, translate: () => {}, setLanguage: () => {} },
      awgGeoClient: { attach: ({ node, save }) => { node.saveGeo = save; } },
      awgDiagnostics: { paintRates: () => {}, createPoller: () => ({ stop() {}, start() {} }) } },
    document, CSS: { escape: (id) => id }, localStorage: { getItem: () => null },
    setTimeout: () => 0, clearTimeout: () => {},
  });
  await new Promise(setImmediate);
  return {
    document, calls, loginInputs, card: (index = 0) => container.cards[index],
    setRows: async (next) => {
      rows = next;
      await document.querySelector('#login-form').handlers.submit({ preventDefault() {} });
      await new Promise(setImmediate);
    },
    fail: (code) => { failure = Object.assign(new Error('Request rejected'), { code }); },
    failLogin: () => { loginFailure = Object.assign(new Error('Invalid credentials'), { status: 401 }); },
    failRefresh: () => { refreshFailure = true; },
    failPasswordChange: () => { passwordChangeFailure = Object.assign(new Error('Invalid credentials'), { status: 403 }); },
    change: async (selector, checked) => {
      const control = container.cards[0].querySelector(selector);
      control.checked = checked;
      control.focus();
      await control.handlers.change();
    },
  };
};

test('a Cell-assigned client cannot export a profile before the Cell confirms settings', async () => {
  const f = await setup();
  await f.setRows([{ id: 'cell-client', name: 'Cell client', address4: '10.9.0.2',
    networkGroup: 'guest', enabled: true, ipv4Enabled: true, ipv6Enabled: false,
    ipv6Available: false, entryCellId: 'a'.repeat(32), entryReady: false }]);
  const button = f.card().querySelector('.show-profile');
  assert.equal(f.card().dataset.clientId, 'cell-client', f.document.querySelector('#notice').textContent);
  assert.equal(button.disabled, true);
  assert.equal(button.dataset.i18n, 'cellPendingShort');
  assert.equal(button.handlers.click, undefined);
});

test('wrong panel password shows a translated visible error', async () => {
  const f = await setup();
  f.failLogin();
  await f.document.querySelector('#login-form').handlers.submit({ preventDefault() {} });
  const notice = f.document.querySelector('#notice');
  assert.equal(notice.textContent, 'invalidPassword');
  assert.equal(notice.className, 'notice error');
});

test('code-only sign-in hides password but submits the authenticator code', async () => {
  const f = await setup({ mode: 'totp' });
  assert.equal(f.document.querySelector('#login-password-field').classList.contains('hidden'), true);
  assert.equal(f.document.querySelector('#login-code-field').classList.contains('hidden'), false);
  f.document.querySelector('#password').value = '';
  f.document.querySelector('#login-code').value = '123456';
  await f.document.querySelector('#login-form').handlers.submit({ preventDefault() {} });
  assert.deepEqual(f.loginInputs, [{ password: '', code: '123456' }]);
});

test('password-and-code sign-in requires both fields in the panel', async () => {
  const f = await setup({ mode: 'password_totp' });
  assert.equal(f.document.querySelector('#password').required, true);
  assert.equal(f.document.querySelector('#login-code').required, true);
  assert.equal(f.document.querySelector('#login-password-field').classList.contains('hidden'), false);
  assert.equal(f.document.querySelector('#login-code-field').classList.contains('hidden'), false);
});

test('password change confirms success in the panel notice after ending the session', async () => {
  const f = await setup();
  const form = f.document.querySelector('#password-form');
  form.reset = () => {};
  await form.handlers.submit({ preventDefault() {}, target: form });
  assert.equal(f.document.querySelector('#notice').textContent, 'passwordChanged');
  assert.equal(f.document.querySelector('#notice').className, 'notice success');
  assert.equal(f.document.querySelector('#login-view').classList.contains('hidden'), false);
  assert.equal(f.document.querySelector('#app-view').classList.contains('hidden'), true);
});

test('rejected password change shows an error and never confirms success', async () => {
  const f = await setup();
  f.failPasswordChange();
  await f.document.querySelector('#password-form').handlers.submit({ preventDefault() {}, target: f.document.querySelector('#password-form') });
  assert.equal(f.document.querySelector('#notice').className, 'notice error');
  assert.notEqual(f.document.querySelector('#notice').textContent, 'passwordChanged');
});

test('card sections start closed and retain independent open states through family updates', async () => {
  const f = await setup();
  assert.equal(f.card().querySelector('.access-settings').open, false);
  assert.equal(f.card().querySelector('.diagnostics').open, false);
  f.card().querySelector('.access-settings').open = true;
  f.card(1).querySelector('.diagnostics').open = true;
  for (const [selector, checked, summary] of [
    ['.ipv6-toggle', false, 'ip4Only'], ['.ipv4-toggle', false, 'disabled'],
    ['.ipv6-toggle', true, 'ip6Only'], ['.ipv4-toggle', true, 'ipBoth'],
  ]) {
    await f.change(selector, checked);
    assert.equal(f.card().querySelector('.ip-summary').textContent, summary);
    assert.equal(f.card().querySelector('.status').textContent, 'Home');
    assert.equal(f.card().querySelector('.access-settings').open, true);
    assert.equal(f.card().querySelector('.diagnostics').open, false);
    assert.equal(f.card(1).querySelector('.access-settings').open, false);
    assert.equal(f.card(1).querySelector('.diagnostics').open, true);
    assert.strictEqual(f.document.activeElement, f.card().querySelector(selector));
  }
  assert.equal(f.calls.length, 4);
});

test('server safety rejection reverts the checkbox without hiding its settings or changing mode', async () => {
  const f = await setup();
  f.card().querySelector('.access-settings').open = true;
  f.fail('CURRENT_PANEL_PATH');
  await f.change('.ipv4-toggle', false);
  assert.equal(f.card().querySelector('.ipv4-toggle').checked, true);
  assert.equal(f.card().querySelector('.ipv4-toggle').disabled, false);
  assert.equal(f.card().querySelector('.access-settings').open, true);
  assert.equal(f.card().querySelector('.ip-summary').textContent, 'ipBoth');
  assert.equal(f.document.querySelector('#notice').textContent, 'CURRENT_PANEL_PATH');
});

test('an unsuccessful refresh preserves the successfully saved mode and open settings', async () => {
  const f = await setup();
  f.card().querySelector('.access-settings').open = true;
  f.failRefresh();
  await f.change('.ipv6-toggle', false);
  assert.equal(f.card().querySelector('.ipv6-toggle').checked, false);
  assert.equal(f.card().querySelector('.access-settings').open, true);
  assert.equal(f.card().querySelector('.ip-summary').textContent, 'ip4Only');
});

test('closed settings stay closed when a Home/Guest change refreshes the cards', async () => {
  const f = await setup();
  await f.change('.group-toggle', false);
  assert.equal(f.card().querySelector('.status').textContent, 'Guest');
  assert.equal(f.card().querySelector('.access-settings').open, false);
  assert.strictEqual(f.document.activeElement, f.card().querySelector('.group-toggle'));
  assert.equal(f.document.querySelector('#notice').textContent, 'accessApplied');
});

test('successful IP-family mutation confirms application, rejected mutation never confirms success', async () => {
  const f = await setup();
  await f.change('.ipv6-toggle', false);
  assert.equal(f.document.querySelector('#notice').textContent, 'accessApplied');
  f.fail('CURRENT_PANEL_PATH');
  await f.change('.ipv4-toggle', false);
  assert.equal(f.document.querySelector('#notice').textContent, 'CURRENT_PANEL_PATH');
  assert.equal(f.document.querySelector('#notice').className, 'notice error');
});

test('GeoIP save confirms success only after the API accepts the policy', async () => {
  const f = await setup();
  await f.card().saveGeo({ mode: 'block', countries: ['RU'] });
  assert.equal(f.document.querySelector('#notice').textContent, 'geoApplied');
  f.fail('GEO_UNAVAILABLE');
  await assert.rejects(f.card().saveGeo({ mode: 'allow', countries: ['RU'] }));
  assert.equal(f.document.querySelector('#notice').className, 'notice error');
  assert.notEqual(f.document.querySelector('#notice').textContent, 'geoApplied');
});
