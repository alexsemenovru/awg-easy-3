'use strict';

(() => {
  const api = window.awgApi;
  const i18n = window.awgI18n;
  const t = i18n.t;
  const $ = (selector) => document.querySelector(selector);
  const loginView = $('#login-view');
  const appView = $('#app-view');
  const logout = $('#logout');
  const clientsNode = $('#clients');
  const notice = $('#notice');
  const connectionView = $('#connection-view');
  const connectionMessage = $('#connection-message');
  const retryConnection = $('#retry-connection');
  const createDialog = $('#create-dialog');
  const profileDialog = $('#profile-dialog');
  const deleteDialog = $('#delete-dialog');
  const languageSelect = $('#language');
  const supportedLanguages = ['en', 'ru', 'fa', 'es', 'zh-cn'];
  const groupLabel = value => value === 'guest' ? t('guestShort')
    : t('homeGroupOption', { number: value === 'home' ? 1 : Number(value.slice(4)) });
  const fillGroupOptions = (select, selected = select.value) => {
    select.replaceChildren();
    for (const [value, label] of [['guest', t('guestOption')],
      ...Array.from({ length: 10 }, (_, index) => [index ? `home${index + 1}` : 'home',
        t('homeGroupOption', { number: index + 1 })])]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = selected;
  };
  let clients = [];
  let exitCells = [];
  const fillExitOptions = (select, client) => {
    const selected = client.exitNodeId ?? client.entryCellId ?? 'main';
    const entries = [['main', t('mainNode')], ...exitCells.map(cell =>
      [cell.id, t('cellOption', { id: cell.id.slice(0, 8) })])];
    if (!entries.some(([id]) => id === selected)) entries.push([selected, t('cellOption', { id: selected.slice(0, 8) })]);
    select.replaceChildren(...entries.map(([id, label]) => {
      const option = document.createElement('option'); option.value = id; option.textContent = label; return option;
    }));
    select.value = selected;
  };
  let selectedClient;
  let pendingDelete;
  let pendingRename;
  let lastDiagnostics = [];
  let geoCountries = [];
  let authMode = 'password';
  let pendingEntryTimer;
  const applyAuthMode = (mode) => {
    const previousMode = authMode;
    authMode = ['password', 'password_totp', 'totp'].includes(mode) ? mode : 'password';
    $('#login-password-field').classList.toggle('hidden', authMode === 'totp');
    $('#password').required = authMode !== 'totp';
    $('#login-code-field').classList.toggle('hidden', authMode === 'password');
    $('#login-code').required = authMode !== 'password';
    $('#password-form').classList.toggle('hidden', authMode === 'totp');
    $('#code-only-password-hint').classList.toggle('hidden', authMode !== 'totp');
    $('#password-code-field').classList.toggle('hidden', authMode !== 'password_totp');
    $('#password-code').required = authMode === 'password_totp';
    $('#totp-start-form').classList.toggle('hidden', authMode !== 'password');
    $('#auth-mode-form').classList.toggle('hidden', authMode === 'password');
    if (previousMode !== authMode) $('#auth-mode').value = authMode;
    $('#mode-password-field').classList.toggle('hidden', authMode === 'totp');
    $('#mode-password').required = authMode !== 'totp';
    $('#mode-code-field').classList.toggle('hidden', authMode === 'password');
    $('#mode-code').required = authMode !== 'password';
    $('#mode-new-password-field').classList.toggle('hidden', authMode !== 'totp');
    $('#mode-new-password').required = authMode === 'totp';
    if (previousMode !== authMode) $('#totp-confirm-area').classList.add('hidden');
  };
  const { paintRates, createPoller } = window.awgDiagnostics;
  const geoStatus = window.awgGeoStatus?.({ load: signal => api.geoInfo(signal), createPoller,
    node: $('#geo-status'), translate: t, onData: status => { geoCountries = status.countries || []; } });
  const cellsView = window.awgCells?.({ api, node: $('#cells-view'),
    summary: $('#cells-summary'), list: $('#cells-list'), translate: t, createPoller,
    onClientsChanged: () => loadClients() });

  const savedLanguage = localStorage.getItem('awg-easy-language');
  if (supportedLanguages.includes(savedLanguage)) {
    i18n.setLanguage(savedLanguage);
    languageSelect.value = savedLanguage;
  }

  const showNotice = (message, error = false, timeout = 5000) => {
    notice.textContent = message;
    notice.className = `notice ${error ? 'error' : 'success'}`;
    clearTimeout(showNotice.timer);
    if (timeout) showNotice.timer = setTimeout(() => notice.classList.add('hidden'), timeout);
  };
  const showLogin = () => {
    backupView?.stop();
    clearTimeout(pendingEntryTimer);
    geoStatus?.stop();
    cellsView?.stop();
    diagnosticsPoller.stop();
    lastDiagnostics = [];
    $('#totp-secret').value = '';
    $('#totp-qr').replaceChildren();
    $('#totp-confirm-area').classList.add('hidden');
    $('#totp-start-form').reset();
    $('#totp-confirm-form').reset();
    loginView.classList.remove('hidden'); appView.classList.add('hidden'); logout.classList.add('hidden');
  };
  const showApp = () => {
    backupView?.refresh();
    geoStatus?.start();
    cellsView?.start();
    loginView.classList.add('hidden'); appView.classList.remove('hidden'); logout.classList.remove('hidden');
  };
  const guarded = async (action) => {
    try { return await action(); } catch (error) {
      if (error.status === 401) showLogin();
      showNotice(errorMessage(error), true);
      throw error;
    }
  };
  const errorMessage = (error) => ['CURRENT_PANEL_PATH', 'LAST_HOME', 'IPV6_UNAVAILABLE'].includes(error.code)
    ? t(error.code) : error.status === 429 ? t('tooManyAttempts')
      : error.status === 403 && error.message === 'Invalid credentials' ? t('invalidCredentials')
        : error.message;
  const showManualLink = (link) => {
    const field = $('#profile-link');
    field.value = link;
    $('#manual-copy').classList.remove('hidden');
    field.focus();
    field.select();
    field.setSelectionRange(0, field.value.length);
  };
  const formatHandshake = (seconds) => {
    if (seconds === null || seconds === undefined) return t('never');
    if (seconds < 60) return t('secondsAgo', { count: seconds });
    return t('minutesAgo', { count: Math.floor(seconds / 60) });
  };
  const paintDiagnostics = (item) => {
    const node = clientsNode.querySelector(`[data-client-id="${CSS.escape(item.id)}"]`);
    if (!node) return;
    const line = node.querySelector('.live-line');
    line.className = `live-line ${item.state}`;
    node.querySelector('.live-state').dataset.i18n = item.state;
    node.querySelector('.live-state').textContent = t(item.state);
    paintRates(node, item, t);
    node.querySelector('.diag-handshake').textContent = formatHandshake(item.handshakeAgeSeconds);
    node.querySelector('.diag-endpoint').textContent = item.endpoint || '—';
    node.querySelector('.diag-mtu').textContent = item.mtu;
    node.querySelector('.diag-keepalive').textContent = `${item.persistentKeepalive} s`;
    node.querySelector('.diag-window').textContent = item.sampleIntervalSeconds == null ? '—'
      : t('sampleSeconds', { count: item.sampleIntervalSeconds.toFixed(1) });
  };
  const clearDiagnostics = (key = 'diagnosticsUnavailable') => {
    lastDiagnostics = [];
    clientsNode.querySelectorAll('.client-card').forEach((node) => {
      node.querySelector('.live-line').className = 'live-line unavailable';
      const state = node.querySelector('.live-state');
      state.dataset.i18n = key;
      state.textContent = t(key);
      paintRates(node, { state: 'unavailable' }, t);
      node.querySelectorAll('.diagnostics dd').forEach((field) => { field.textContent = '—'; });
    });
  };
  const diagnosticsPoller = createPoller({
    load: (signal) => api.diagnostics(signal),
    onData: (items) => {
      if (!Array.isArray(items)) throw new Error('Invalid diagnostics response');
      clearDiagnostics();
      lastDiagnostics = items;
      items.forEach(paintDiagnostics);
    },
    onError: (error) => { clearDiagnostics(); if (error.status === 401) showLogin(); },
  });
  function startDiagnostics() {
    if (!appView.classList.contains('hidden') && !document.hidden) diagnosticsPoller.start();
  }
  document.addEventListener('visibilitychange', () => {
    geoStatus?.stop();
    cellsView?.stop();
    if (!document.hidden && !appView.classList.contains('hidden')) geoStatus?.start();
    if (!document.hidden && !appView.classList.contains('hidden')) cellsView?.start();
    diagnosticsPoller.stop();
    clearDiagnostics('checking');
    startDiagnostics();
  });
  const update = async (client, changes, input) => {
    const keepFocus = document.activeElement === input;
    const inputSelector = ['.group-select', '.client-exit', '.ipv4-toggle', '.ipv6-toggle'].find((selector) => input.matches(selector));
    const controls = [...clientsNode.querySelectorAll('input, select, button')];
    const previousDisabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    let applied = false;
    try {
      const saved = await guarded(() => api.updateClient(client.id, changes));
      applied = true;
      showNotice(t('accessApplied', { name: saved.name }));
      clients = clients.map((item) => item.id === saved.id ? saved : item);
      clientsNode.replaceChildren(...clients.map(renderClient));
      await loadClients();
    } catch {
      // A failed refresh must not pretend that a successful server change was undone.
      if (!applied) {
        if (inputSelector === '.group-select') input.value = client.networkGroup;
        else if (inputSelector === '.client-exit') input.value = client.exitNodeId ?? client.entryCellId ?? 'main';
        else input.checked = !input.checked;
      }
    } finally {
      controls.forEach((control, index) => { control.disabled = previousDisabled[index]; });
      if (keepFocus && inputSelector) {
        clientsNode.querySelector(`[data-client-id="${CSS.escape(client.id)}"]`)
          ?.querySelector(inputSelector)?.focus({ preventScroll: true });
      }
    }
  };
  const askDelete = (client) => {
    pendingDelete = client;
    $('#delete-message').textContent = t('deleteConfirm', { name: client.name });
    deleteDialog.showModal();
  };
  const renderClient = (client) => {
    const node = $('#client-template').content.firstElementChild.cloneNode(true);
    // Read the live DOM before replacing cards: native toggle events can be deferred.
    const previous = clientsNode.querySelector(`[data-client-id="${CSS.escape(client.id)}"]`);
    for (const section of ['.diagnostics', '.access-settings']) {
      node.querySelector(section).open = previous?.querySelector(section).open ?? false;
    }
    i18n.translate(node);
    node.dataset.clientId = client.id;
    node.querySelector('.client-name').textContent = client.name;
    node.querySelector('.client-address').textContent = [client.address4, client.address6].filter(Boolean).join(' · ');
    const entryLabel = node.querySelector('.client-entry-label');
    if (client.entryCellId) {
      entryLabel.classList.remove('hidden');
      entryLabel.textContent = t('cellOption', { id: client.entryCellId.slice(0, 8) });
    }
    const status = node.querySelector('.status');
    // Group and traffic permission are independent, including when both IP families are off.
    status.textContent = groupLabel(client.networkGroup);
    status.className = `status ${client.networkGroup === 'guest' ? 'guest' : 'home'}`;
    const summary = node.querySelector('.ip-summary');
    const summaryKey = !client.enabled ? 'disabled' : client.ipv4Enabled && client.ipv6Enabled ? 'ipBoth'
      : client.ipv6Enabled ? 'ip6Only' : 'ip4Only';
    summary.dataset.i18n = summaryKey;
    summary.textContent = t(summaryKey);
    const group = node.querySelector('.group-select');
    fillGroupOptions(group, client.networkGroup);
    group.addEventListener('change', () => update(client, { networkGroup: group.value }, group));
    const exit = node.querySelector('.client-exit');
    fillExitOptions(exit, client);
    node.querySelector('.client-exit-row').classList.toggle('hidden', !exitCells.length && !client.exitNodeId);
    exit.addEventListener('change', () => update(client, { exitNodeId: exit.value }, exit));
    for (const family of [4, 6]) {
      const control = node.querySelector(`.ipv${family}-toggle`);
      control.checked = client[`ipv${family}Enabled`];
      control.disabled = family === 6 && !client.ipv6Available;
      control.addEventListener('change', () => update(client, { [`ipv${family}Enabled`]: control.checked }, control));
    }
    node.querySelector('.ipv6-unavailable').classList.toggle('hidden', client.ipv6Available);
    window.awgTooltips?.attach(node);
    node.querySelector('.ipv6-only-warning').classList.toggle('hidden', !client.ipv6Enabled || client.ipv4Enabled);
    const profileButton = node.querySelector('.show-profile');
    if (client.entryCellId && !client.entryReady) {
      profileButton.disabled = true;
      profileButton.dataset.i18n = 'cellPendingShort';
      profileButton.textContent = t('cellPendingShort');
      profileButton.title = t('cellProfilePending');
      profileButton.setAttribute('aria-label', t('cellProfilePending'));
    } else profileButton.addEventListener('click', () => openProfile(client));
    node.querySelector('.delete-client').addEventListener('click', () => askDelete(client));
    node.querySelector('.rename-client').addEventListener('click', () => {
      pendingRename = client;
      $('#rename-client-name').value = client.name;
      $('#rename-dialog').showModal();
      $('#rename-client-name').select();
    });
    window.awgGeoClient?.attachRoute?.({ node, client, codes: () => geoCountries,
      language: () => languageSelect.value || 'en', t, available: exitCells.length > 0, fillExits: fillExitOptions,
      save: async geoRoute => {
        const saved = await guarded(() => api.updateClient(client.id, { geoRoute }));
        showNotice(t('geoApplied', { name: saved.name }));
        clients = clients.map(item => item.id === saved.id ? saved : item);
        clientsNode.replaceChildren(...clients.map(renderClient)); lastDiagnostics.forEach(paintDiagnostics);
      },
    });
    window.awgGeoClient?.attach({ node, client, codes: () => geoCountries,
      language: () => languageSelect.value || 'en', t,
      save: async geoPolicy => {
        const saved = await guarded(() => api.updateClient(client.id, { geoPolicy }));
        showNotice(t('geoApplied', { name: saved.name }));
        clients = clients.map(item => item.id === saved.id ? saved : item);
        clientsNode.replaceChildren(...clients.map(renderClient));
        lastDiagnostics.forEach(paintDiagnostics);
      },
    });
    return node;
  };
  const loadClients = async () => {
    clearTimeout(pendingEntryTimer);
    diagnosticsPoller.stop();
    clearDiagnostics('checking');
    clients = await guarded(() => api.clients());
    try {
      const inventory = await api.cellsInfo();
      exitCells = inventory.state === 'ready' ? inventory.cells.filter(cell => cell.status === 'consumed' && cell.phase === 'closed') : [];
    } catch { exitCells = []; }
    if (api.geoInfo) {
      try { geoCountries = (await api.geoInfo()).countries || []; } catch { geoCountries = []; }
    }
    clientsNode.replaceChildren(...clients.map(renderClient));
    if (clients.some(client => client.entryCellId && !client.entryReady)) {
      pendingEntryTimer = setTimeout(() => {
        if (!document.hidden && !appView.classList.contains('hidden')) loadClients().catch(() => {});
      }, 15000);
    }
    startDiagnostics();
    // Failure here must not undo a successful client mutation or hide its result.
    try {
      const network = await api.network();
      for (const family of [4, 6]) {
        const link = $(`#panel-ipv${family}`);
        const address = network[`panelIpv${family}Url`];
        link.classList.toggle('hidden', !address);
        if (address) link.href = address;
      }
    } catch { $('#panel-ipv4').classList.add('hidden'); $('#panel-ipv6').classList.add('hidden'); }
  };
  const openProfile = (client) => {
    selectedClient = client;
    $('#profile-title').textContent = client.name;
    $('#download-config').href = api.exportUrl(client.id, 'native-config');
    $('#manual-copy').classList.add('hidden');
    $('#profile-link').value = '';
    profileDialog.showModal();
  };

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('#password');
    try {
      await api.login(password.value, $('#login-code').value);
      notice.classList.add('hidden');
      password.value = '';
      $('#login-code').value = '';
      applyAuthMode((await api.session()).authMode);
      showApp();
      await loadClients();
    } catch (error) {
      showNotice(error.status === 429 ? t('tooManyAttempts') : error.status === 401
        ? t(authMode === 'password' ? 'invalidPassword' : 'invalidCredentials') : errorMessage(error), true);
    }
  });
  logout.addEventListener('click', async () => { await api.logout(); showLogin(); });
  languageSelect.addEventListener('change', () => {
    i18n.setLanguage(languageSelect.value);
    localStorage.setItem('awg-easy-language', languageSelect.value);
    for (const select of document.querySelectorAll('#client-group, .group-select')) {
      fillGroupOptions(select);
    }
    for (const client of clients) {
      const card = clientsNode.querySelector(`[data-client-id="${CSS.escape(client.id)}"]`);
      if (card) card.querySelector('.status').textContent = groupLabel(client.networkGroup);
    }
    for (const option of $('#client-entry').options) {
      if (option.value) option.textContent = t('cellOption', { id: option.value.slice(0, 8) });
    }
    for (const client of clients.filter(item => item.entryCellId)) {
      const card = clientsNode.querySelector(`[data-client-id="${CSS.escape(client.id)}"]`);
      if (!card) continue;
      card.querySelector('.client-entry-label').textContent = t('cellOption', { id: client.entryCellId.slice(0, 8) });
      if (!client.entryReady) {
        const button = card.querySelector('.show-profile');
        button.title = t('cellProfilePending');
        button.setAttribute('aria-label', t('cellProfilePending'));
      }
    }
    lastDiagnostics.forEach(paintDiagnostics);
    geoStatus?.translate();
    cellsView?.translate();
    for (const client of clients) {
      const select = clientsNode.querySelector(`[data-client-id="${CSS.escape(client.id)}"] .client-exit`);
      if (select) fillExitOptions(select, client);
    }
  });
  $('#show-create').addEventListener('click', async () => {
    const entrySelect = $('#client-entry');
    fillGroupOptions($('#client-group'), 'guest');
    entrySelect.replaceChildren(entrySelect.querySelector('option[value=""]'));
    createDialog.showModal();
    try {
      const inventory = await api.cellsInfo();
      if (!createDialog.open || inventory.state !== 'ready') return;
      for (const cell of inventory.cells.filter(item => item.entryReady)) {
        const option = document.createElement('option');
        option.value = cell.id;
        option.textContent = t('cellOption', { id: cell.id.slice(0, 8) });
        entrySelect.append(option);
      }
    } catch { /* The Main Node remains available when Cell status cannot be loaded. */ }
  });
  document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  $('#cancel-delete').addEventListener('click', () => deleteDialog.close());
  $('#confirm-delete').addEventListener('click', async () => {
    const client = pendingDelete;
    if (!client) return;
    deleteDialog.close();
    clients = clients.filter((item) => item.id !== client.id);
    clientsNode.querySelector(`[data-client-id="${CSS.escape(client.id)}"]`)?.remove();
    showNotice(t('deletingClient'), false, 0);
    try {
      await api.deleteClient(client.id);
      showNotice(t('deleted'));
      await loadClients();
    } catch (error) {
      if (error.status === 401) showLogin();
      if (error instanceof TypeError && error.message === 'Failed to fetch') {
        showNotice(t('deletedConnectionLost'), true, 0);
        return;
      }
      showNotice(errorMessage(error), true);
      await loadClients().catch(() => {});
    } finally { pendingDelete = undefined; }
  });
  $('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('#client-name').value.trim();
    if (clients.some((client) => client.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      showNotice(t('duplicateName'), true);
      return;
    }
    try {
      const result = await guarded(() => api.createClient({ name, networkGroup: $('#client-group').value,
        ...($('#client-entry').value ? { entryCellId: $('#client-entry').value } : {}) }));
      createDialog.close();
      event.target.reset();
      await loadClients();
      if (result.client.entryCellId && !result.client.entryReady) showNotice(t('cellAssignmentPending'));
      else openProfile(result.client);
    } catch (error) {
      if (error.status === 409) showNotice(t('duplicateName'), true);
    }
  });
  $('#show-profile-link').addEventListener('click', async () => {
    let link;
    try { link = await guarded(() => api.exportText(selectedClient.id, 'vpn-link')); } catch { return; }
    showManualLink(link);
  });
  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await guarded(() => api.changePassword($('#current-password').value, $('#new-password').value, $('#password-code').value));
      event.target.reset();
      showLogin();
      showNotice(t('passwordChanged'));
    } catch {}
  });
  $('#rename-form').addEventListener('submit', async event => {
    event.preventDefault();
    const client = pendingRename;
    if (!client) return;
    const button = event.target.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const saved = await guarded(() => api.updateClient(client.id, { name: $('#rename-client-name').value.trim() }));
      clients = clients.map(item => item.id === saved.id ? saved : item);
      clientsNode.replaceChildren(...clients.map(renderClient));
      lastDiagnostics.forEach(paintDiagnostics);
      $('#rename-dialog').close();
      showNotice(t('clientRenamed'));
    } catch (error) {
      if (error.status === 409) showNotice(t('duplicateName'), true);
    } finally { button.disabled = false; }
  });
  $('#rename-dialog').addEventListener('close', () => { pendingRename = null; $('#rename-form').reset(); });
  $('#totp-start-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await guarded(() => api.beginTotp($('#totp-start-password').value));
      const image = document.createElement('img');
      image.alt = t('totpQrAlt');
      image.src = `data:image/svg+xml,${encodeURIComponent(result.qrSvg)}`;
      $('#totp-qr').replaceChildren(image);
      $('#totp-secret').value = result.secret;
      $('#totp-confirm-area').classList.remove('hidden');
      showNotice(t('totpScanHint'));
    } catch (error) { if (error.status === 429) showNotice(t('tooManyAttempts'), true); }
  });
  $('#totp-confirm-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await guarded(() => api.confirmTotp($('#totp-confirm-password').value, $('#totp-confirm-code').value));
      event.target.reset();
      $('#totp-start-form').reset();
      $('#totp-secret').value = '';
      $('#totp-qr').replaceChildren();
      applyAuthMode('password_totp');
      showLogin();
      showNotice(t('totpActivated'));
    } catch (error) { if (error.status === 429) showNotice(t('tooManyAttempts'), true); }
  });
  $('#auth-mode-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const target = $('#auth-mode').value;
    if (target === authMode) { showNotice(t('modeUnchanged')); return; }
    try {
      await guarded(() => api.setAuthMode(target, $('#mode-password').value, $('#mode-code').value, $('#mode-new-password').value));
      event.target.reset();
      applyAuthMode(target);
      showLogin();
      showNotice(t('authModeChanged'));
    } catch (error) { if (error.status === 429) showNotice(t('tooManyAttempts'), true); }
  });
  const backupView = window.awgBackup?.({ api, t, authMode: () => authMode, showNotice });
  const connection = window.awgConnection({
    load: (signal) => api.session(signal),
    createPoller,
    onState: (state) => {
      connectionView.classList.toggle('hidden', state === 'ready');
      const key = state === 'unavailable' ? 'panelUnavailable' : 'panelConnecting';
      connectionMessage.dataset.i18n = key;
      connectionMessage.textContent = t(key);
      retryConnection.disabled = state === 'connecting';
      retryConnection.classList.toggle('hidden', state !== 'unavailable');
      if (state === 'unavailable') clearDiagnostics();
    },
    onSession: ({ authenticated, language, authMode: sessionAuthMode }) => {
    applyAuthMode(sessionAuthMode);
    const selectedLanguage = supportedLanguages.includes(localStorage.getItem('awg-easy-language'))
      ? localStorage.getItem('awg-easy-language') : language;
    i18n.setLanguage(selectedLanguage);
    languageSelect.value = selectedLanguage;
    if (!authenticated) return showLogin();
    showApp();
    loadClients().catch(() => {});
    },
  });
  retryConnection.addEventListener('click', () => connection.retry());
  window.addEventListener('online', () => connection.retry());
  window.addEventListener('pageshow', (event) => { if (event.persisted) connection.start(); });
  window.addEventListener('pagehide', () => { clearTimeout(pendingEntryTimer); connection.stop(); geoStatus?.stop(); cellsView?.stop(); backupView?.stop(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      connection.start();
      if (clients.some(client => client.entryCellId && !client.entryReady)
        && !appView.classList.contains('hidden')) loadClients().catch(() => {});
    } else connection.stop();
  });
  connection.start();
})();
