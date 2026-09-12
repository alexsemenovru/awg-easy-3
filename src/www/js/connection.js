'use strict';

// Only probes session availability. Never retries a mutation or stores credentials.
window.awgConnection = ({ load, onSession, onState, createPoller }) => {
  let available = false;
  let authenticated;
  const poller = createPoller({
    load,
    intervalMs: 15000,
    timeoutMs: 8000,
    onData: (session) => {
      if (typeof session?.authenticated !== 'boolean') throw new Error('Invalid session response');
      const changed = !available || authenticated !== session.authenticated;
      available = true;
      authenticated = session.authenticated;
      onState('ready');
      if (changed) onSession(session);
    },
    onError: () => { available = false; onState('unavailable'); },
  });
  return Object.freeze({
    start: () => { onState('connecting'); return poller.start(); },
    retry: () => { onState('connecting'); return poller.refresh(); },
    stop: poller.stop,
  });
};
