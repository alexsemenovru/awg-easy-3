'use strict';

window.awgCells = ({ api, node, summary, list, translate, createPoller }) => {
  let snapshot = null;
  const issueButton = node.querySelector?.('#issue-cell');
  const actionStatus = node.querySelector?.('#cells-action-status');
  const invitationDialog = document.querySelector?.('#cell-invitation-dialog');
  const invitationCode = document.querySelector?.('#cell-invitation-code');
  const copyButton = document.querySelector?.('#copy-cell-invitation');
  const copyStatus = document.querySelector?.('#cell-copy-status');
  invitationDialog?.addEventListener('close', () => { invitationCode.value = ''; if (copyStatus) copyStatus.textContent = ''; });
  issueButton?.addEventListener('click', async () => {
    issueButton.disabled = true;
    actionStatus.textContent = '';
    try {
      const result = await api.issueCellInvitation();
      if (typeof result?.code !== 'string') throw new Error();
      invitationCode.value = result.code;
      invitationDialog.showModal();
      invitationCode.focus();
    } catch { actionStatus.textContent = translate('cellsInvitationError'); }
    finally { issueButton.disabled = false; }
  });
  copyButton?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(invitationCode.value);
      if (copyStatus) copyStatus.textContent = translate('cellsCopied'); }
    catch { invitationCode.select(); if (copyStatus) copyStatus.textContent = translate('cellsCopyManual'); }
  });
  const render = () => {
    list.replaceChildren();
    if (!snapshot || snapshot.state === 'unavailable') {
      node.classList.add('hidden');
      return;
    }
    node.classList.remove('hidden');
    if (snapshot.state !== 'ready') {
      summary.textContent = translate('cellsStale');
      return;
    }
    summary.textContent = translate('cellsCount', { count: snapshot.cells.length });
    if (snapshot.cells.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = translate('cellsEmpty');
      list.append(empty);
      return;
    }
    for (const cell of snapshot.cells) {
      const row = document.createElement('div');
      row.className = 'cell-row';
      const name = document.createElement('code');
      name.textContent = `#${cell.id.slice(0, 8)}`;
      const state = document.createElement('span');
      state.textContent = translate(cell.status === 'revoked' ? 'cellsRevoked'
        : cell.status === 'pending' ? 'cellsPending'
          : cell.phase === 'closed' ? 'cellsJoined' : 'cellsJoining');
      row.append(name, state);
      if (cell.status === 'consumed' && cell.phase === 'closed') {
        const fresh = cell.control && Number.isSafeInteger(cell.control.receivedAt)
          && cell.control.receivedAt <= Date.now() + 30000 && Date.now() - cell.control.receivedAt <= 120000;
        const label = translate(!fresh || !cell.control.path ? 'cellsControlUnknown'
          : cell.control.path === 'technical' ? 'cellsControlTechnical' : 'cellsControlDirect');
        // Native disclosure remains usable with keyboard and touch, unlike
        // a hover-only title. Addresses, keys and client activity stay private.
        const details = document.createElement('details');
        details.className = 'cell-control';
        const caption = document.createElement('summary');
        caption.textContent = label;
        const explanation = document.createElement('p');
        explanation.textContent = translate('cellsControlHint');
        details.append(caption, explanation);
        if (cell.control?.receivedAt) {
          const received = document.createElement('p');
          received.textContent = translate('cellsLastControl', { time: new Date(cell.control.receivedAt).toLocaleString() });
          details.append(received);
        }
        row.append(details);
      }
      if (cell.settings) {
        const revision = document.createElement('span');
        revision.className = 'cell-revision';
        revision.textContent = translate('cellsRevision', {
          confirmed: cell.settings.confirmedRevision ?? '—',
          desired: cell.settings.desiredRevision ?? '—',
        });
        row.append(revision);
      }
      if (cell.backup?.generation) {
        const backup = document.createElement('span');
        backup.textContent = translate(cell.backup.confirmed ? 'backupCellConfirmed' : 'backupCellPending',
          { generation: cell.backup.generation });
        row.append(backup);
      }
      list.append(row);
    }
  };
  const poller = createPoller({ load: signal => api.cellsInfo(signal), intervalMs: 30000,
    onData: data => {
      if (!data || !['ready', 'stale', 'unavailable'].includes(data.state)
        || !Array.isArray(data.cells)) throw new Error('Invalid Cell status');
      snapshot = data;
      render();
    },
    onError: () => {
      snapshot = snapshot?.state === 'ready'
        ? { state: 'stale', cells: [] } : { state: 'unavailable', cells: [] };
      render();
    } });
  return Object.freeze({ start: () => poller.start(),
    stop: () => { poller.stop(); snapshot = null; if (actionStatus) actionStatus.textContent = ''; if (invitationDialog?.open) invitationDialog.close(); render(); },
    translate: render });
};
