'use strict';

window.awgBackup = ({ api, t, authMode, showNotice }) => {
  const $ = selector => document.querySelector(selector);
  const form = $('#backup-form');
  const button = $('#create-backup');
  const dialog = $('#backup-dialog');
  const archiveLink = $('#backup-archive');
  const keyLink = $('#backup-key-download');
  const keyField = $('#backup-key');
  let urls = [];
  let epoch = 0;
  const clear = () => {
    urls.forEach(url => URL.revokeObjectURL(url));
    urls = [];
    keyField.value = '';
    archiveLink.removeAttribute('href');
    keyLink.removeAttribute('href');
    $('#backup-copy-status').textContent = '';
  };
  const downloadUrl = (bytes, type) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    urls.push(url);
    return url;
  };
  dialog.addEventListener('close', clear);
  $('#backup-copy-key').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(keyField.value);
      $('#backup-copy-status').textContent = t('cellsCopied');
    } catch {
      keyField.select();
      $('#backup-copy-status').textContent = t('backupCopyManual');
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const current = ++epoch;
    button.disabled = true;
    button.textContent = t('backupCreating');
    form.setAttribute('aria-busy', 'true');
    clear();
    try {
      const result = await api.createBackup($('#backup-password').value, $('#backup-code').value);
      if (current !== epoch) return;
      const bytes = Uint8Array.from(atob(result.archive), character => character.charCodeAt(0));
      archiveLink.href = downloadUrl(bytes, 'application/octet-stream');
      archiveLink.download = `AWG-Easy-3-${result.id}.awgbackup`;
      keyField.value = result.recoveryKey;
      keyLink.href = downloadUrl(`${result.recoveryKey}\n`, 'text/plain;charset=utf-8');
      keyLink.download = `AWG-Easy-3-${result.id}-key.txt`;
      dialog.showModal();
      showNotice(t('backupCreated'));
    } catch (error) {
      if (current !== epoch) return;
      clear();
      showNotice(t(error.status === 429 ? 'tooManyAttempts'
        : error.status === 401 || error.status === 403 ? 'invalidCredentials' : 'backupError'), true);
    } finally {
      form.reset();
      button.disabled = false;
      button.textContent = t('backupCreate');
      form.removeAttribute('aria-busy');
    }
  });
  const refresh = () => {
    const mode = authMode();
    $('#backup-password-field').classList.toggle('hidden', mode === 'totp');
    $('#backup-password').required = mode !== 'totp';
    $('#backup-code-field').classList.toggle('hidden', mode === 'password');
    $('#backup-code').required = mode !== 'password';
  };
  return { refresh, stop: () => {
    epoch++;
    form.reset();
    if (dialog.open) dialog.close();
    clear();
  } };
};
