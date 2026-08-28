'use strict';

window.awgDiagnostics = (() => {
  const formatRate = (bytesPerSecond) => {
    if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond)) return '—';
    const bits = Math.max(0, bytesPerSecond) * 8;
    if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gbit/s`;
    if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbit/s`;
    if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} Kbit/s`;
    return `${Math.round(bits)} bit/s`;
  };

  // One request at a time. Logout or a replaced client list invalidates old
  // responses, even when the transport does not finish immediately on abort.
  const createPoller = ({ load, onData, onError, intervalMs = 4000, timeoutMs = 8000 }) => {
    let running = false;
    let generation = 0;
    let timer;
    let pending;
    const stop = () => {
      running = false;
      generation += 1;
      clearTimeout(timer);
      if (pending) pending.cancel();
      pending = undefined;
    };
    const refresh = () => {
      if (!running) return Promise.resolve();
      if (pending) return pending.promise;
      clearTimeout(timer);
      const version = generation;
      const controller = new AbortController();
      let rejectCancelled;
      const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
      const cancel = () => {
        controller.abort();
        rejectCancelled(new Error('Diagnostics request cancelled or timed out'));
      };
      const deadline = setTimeout(cancel, timeoutMs);
      const request = { cancel };
      pending = request;
      request.promise = Promise.race([
        Promise.resolve().then(() => load(controller.signal)), cancelled,
      ]).then((data) => {
        if (running && generation === version) onData(data);
      }).catch((error) => {
        if (running && generation === version) onError(error);
      }).finally(() => {
        clearTimeout(deadline);
        if (pending === request) pending = undefined;
        if (running && generation === version) timer = setTimeout(refresh, intervalMs);
      });
      return request.promise;
    };
    const start = () => { stop(); running = true; return refresh(); };
    return Object.freeze({ start, stop, refresh });
  };

  return Object.freeze({ formatRate, createPoller });
})();
