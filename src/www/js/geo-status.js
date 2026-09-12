'use strict';

window.awgGeoStatus = ({ load, createPoller, node, translate, onData = () => {} }) => {
  const paint = (state, release = null) => {
    node.dataset.i18n = `geo_${state}`;
    node.textContent = `${translate(`geo_${state}`)}${release ? ` · ${release}` : ''}`;
  };
  let latest;
  const poller = createPoller({ load, intervalMs: 60000, timeoutMs: 8000,
    onData: status => {
      if (!['ready', 'updating', 'stale', 'unavailable'].includes(status?.state)
          || (status.release !== null && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(status.release))) {
        throw new Error('Invalid GeoIP status');
      }
      latest = status;
      onData(status);
      paint(status.state, status.release);
    },
    onError: () => { latest = null; paint('statusUnavailable'); },
  });
  return { start: poller.start, stop: poller.stop,
    translate: () => { if (latest) paint(latest.state, latest.release); } };
};
