'use strict';

window.awgCells = ({ api, node, summary, list, translate, createPoller }) => {
  let snapshot = null;
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
      if (cell.settings) {
        const revision = document.createElement('span');
        revision.className = 'cell-revision';
        revision.textContent = translate('cellsRevision', {
          confirmed: cell.settings.confirmedRevision ?? '—',
          desired: cell.settings.desiredRevision ?? '—',
        });
        row.append(revision);
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
    stop: () => { poller.stop(); snapshot = null; render(); },
    translate: render });
};
