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
  let diagnosticsTimer;

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
  const showLogin = () => { loginView.classList.remove('hidden'); appView.classList.add('hidden'); logout.classList.add('hidden'); };
  const showApp = () => {
    loginView.classList.add('hidden'); appView.classList.remove('hidden'); logout.classList.remove('hidden');
    startDiagnostics();
  };
  const guarded = async (action) => {
    try { return await action(); } catch (error) {
      if (error.status === 401) showLogin();
      showNotice(error.message, true);
      throw error;
    }
  };
  const showManualLink = (link) => {
    const field = $('#profile-link');
    field.value = link;
    $('#manual-copy').classList.remove('hidden');
    field.focus();
    field.select();
    field.setSelectionRange(0, field.value.length);
  };
  const formatRate = (bytesPerSecond) => {
    const bits = Math.max(0, Number(bytesPerSecond) || 0) * 8;
    if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gbit/s`;
    if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbit/s`;
    if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} Kbit/s`;
    return `${Math.round(bits)} bit/s`;
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
    node.querySelector('.live-state').textContent = t(item.state);
    node.querySelector('.live-rates').textContent = item.state === 'online'
      ? `↓ ${formatRate(item.downloadBps)} · ↑ ${formatRate(item.uploadBps)}` : '';
    node.querySelector('.diag-handshake').textContent = formatHandshake(item.handshakeAgeSeconds);
    node.querySelector('.diag-endpoint').textContent = item.endpoint || '—';
    node.querySelector('.diag-mtu').textContent = item.mtu;
    node.querySelector('.diag-keepalive').textContent = `${item.persistentKeepalive} s`;
  };
  const refreshDiagnostics = async () => {
    if (appView.classList.contains('hidden')) return;
    try { (await api.diagnostics()).forEach(paintDiagnostics); }
    catch (error) { if (error.status === 401) showLogin(); }
  };
  function startDiagnostics() {
    clearInterval(diagnosticsTimer);
    refreshDiagnostics();
    diagnosticsTimer = setInterval(refreshDiagnostics, 4000);
  }
  const update = async (client, changes, input) => {
    input.disabled = true;
    try { await guarded(() => api.updateClient(client.id, changes)); await loadClients(); }
    catch { input.checked = !input.checked; }
    finally { input.disabled = false; }
  };
  const askDelete = (client) => {
    pendingDelete = client;
    $('#delete-message').textContent = t('deleteConfirm', { name: client.name });
    deleteDialog.showModal();
  };
  const renderClient = (client) => {
    const node = $('#client-template').content.firstElementChild.cloneNode(true);
    i18n.translate(node);
    node.dataset.clientId = client.id;
    node.querySelector('.client-name').textContent = client.name;
    node.querySelector('.client-address').textContent = [client.address4, client.address6].filter(Boolean).join(' · ');
    const status = node.querySelector('.status');
    status.textContent = client.enabled ? (client.networkGroup === 'home' ? 'Home' : 'Guest') : t('disabled');
    status.className = `status ${client.enabled ? client.networkGroup : 'disabled'}`;
    const group = node.querySelector('.group-toggle');
    group.checked = client.networkGroup === 'home';
    group.addEventListener('change', () => update(client, { networkGroup: group.checked ? 'home' : 'guest' }, group));
    const enabled = node.querySelector('.enabled-toggle');
    enabled.checked = client.enabled;
    enabled.addEventListener('change', () => update(client, { enabled: enabled.checked }, enabled));
    node.querySelector('.show-profile').addEventListener('click', () => openProfile(client));
    node.querySelector('.delete-client').addEventListener('click', () => askDelete(client));
    return node;
  };
  const loadClients = async () => {
    clients = await guarded(() => api.clients());
    clientsNode.replaceChildren(...clients.map(renderClient));
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
    refreshDiagnostics();
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
        showNotice(t('deletedConnectionLost'), false, 0);
        return;
      }
      showNotice(error.message, true);
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
