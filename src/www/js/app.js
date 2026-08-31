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
  const createDialog = $('#create-dialog');
  const profileDialog = $('#profile-dialog');
  const deleteDialog = $('#delete-dialog');
  const languageSelect = $('#language');
  const supportedLanguages = ['en', 'ru', 'fa', 'es', 'zh-cn'];
  let clients = [];
  let selectedClient;
  let pendingDelete;
  let lastDiagnostics = [];
  const { paintRates, createPoller } = window.awgDiagnostics;

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
    diagnosticsPoller.stop();
    lastDiagnostics = [];
    loginView.classList.remove('hidden'); appView.classList.add('hidden'); logout.classList.add('hidden');
  };
  const showApp = () => {
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
    ? t(error.code) : error.message;
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
    diagnosticsPoller.stop();
    clearDiagnostics('checking');
    startDiagnostics();
  });
  const update = async (client, changes, input) => {
    const keepFocus = document.activeElement === input;
    const inputSelector = ['.group-toggle', '.ipv4-toggle', '.ipv6-toggle'].find((selector) => input.matches(selector));
    const controls = [...clientsNode.querySelectorAll('input, button')];
    const previousDisabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    let applied = false;
    try {
      const saved = await guarded(() => api.updateClient(client.id, changes));
      applied = true;
      clients = clients.map((item) => item.id === saved.id ? saved : item);
      clientsNode.replaceChildren(...clients.map(renderClient));
      await loadClients();
    } catch {
      // A failed refresh must not pretend that a successful server change was undone.
      if (!applied) input.checked = !input.checked;
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
    const status = node.querySelector('.status');
    // Group and traffic permission are independent, including when both IP families are off.
    status.textContent = client.networkGroup === 'home' ? 'Home' : 'Guest';
    status.className = `status ${client.networkGroup}`;
    const summary = node.querySelector('.ip-summary');
    const summaryKey = !client.enabled ? 'disabled' : client.ipv4Enabled && client.ipv6Enabled ? 'ipBoth'
      : client.ipv6Enabled ? 'ip6Only' : 'ip4Only';
    summary.dataset.i18n = summaryKey;
    summary.textContent = t(summaryKey);
    const group = node.querySelector('.group-toggle');
    group.checked = client.networkGroup === 'home';
    group.addEventListener('change', () => update(client, { networkGroup: group.checked ? 'home' : 'guest' }, group));
    for (const family of [4, 6]) {
      const control = node.querySelector(`.ipv${family}-toggle`);
      control.checked = client[`ipv${family}Enabled`];
      control.disabled = family === 6 && !client.ipv6Available;
      control.addEventListener('change', () => update(client, { [`ipv${family}Enabled`]: control.checked }, control));
    }
    node.querySelector('.ipv6-unavailable').classList.toggle('hidden', client.ipv6Available);
    node.querySelector('.ipv6-only-warning').classList.toggle('hidden', !client.ipv6Enabled || client.ipv4Enabled);
    node.querySelector('.show-profile').addEventListener('click', () => openProfile(client));
    node.querySelector('.delete-client').addEventListener('click', () => askDelete(client));
    return node;
  };
  const loadClients = async () => {
    diagnosticsPoller.stop();
    clearDiagnostics('checking');
    clients = await guarded(() => api.clients());
    clientsNode.replaceChildren(...clients.map(renderClient));
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
      await guarded(() => api.login(password.value));
      password.value = '';
      showApp();
      await loadClients();
    } catch {}
  });
  logout.addEventListener('click', async () => { await api.logout(); showLogin(); });
  languageSelect.addEventListener('change', () => {
    i18n.setLanguage(languageSelect.value);
    localStorage.setItem('awg-easy-language', languageSelect.value);
    lastDiagnostics.forEach(paintDiagnostics);
  });
  $('#show-create').addEventListener('click', () => createDialog.showModal());
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
      const result = await guarded(() => api.createClient({ name, networkGroup: $('#client-group').value }));
      createDialog.close();
      event.target.reset();
      await loadClients();
      openProfile(result.client);
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
      await guarded(() => api.changePassword($('#current-password').value, $('#new-password').value));
      event.target.reset();
      showLogin();
      alert(t('passwordChanged'));
    } catch {}
  });
  api.session().then(async ({ authenticated, language }) => {
    const selectedLanguage = supportedLanguages.includes(localStorage.getItem('awg-easy-language'))
      ? localStorage.getItem('awg-easy-language') : language;
    i18n.setLanguage(selectedLanguage);
    languageSelect.value = selectedLanguage;
    if (!authenticated) return showLogin();
    showApp();
    return loadClients();
  }).catch((error) => showNotice(error.message, true));
})();
