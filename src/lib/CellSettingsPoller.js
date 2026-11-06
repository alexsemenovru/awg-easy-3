'use strict';

function wait(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }
    signal.addEventListener('abort', finish, { once: true });
  });
}

// Poll only over the verified permanent path. A failed poll changes no
// assignment: CellSettingsReceiver keeps the last acknowledged version.
class CellSettingsPoller {
  constructor({ sync, intervalMs = 10000, maxBackoffMs = 300000,
    onStatus = () => {}, now = Date.now, sleep = wait,
    random = Math.random } = {}) {
    if (typeof sync !== 'function' || typeof onStatus !== 'function'
      || typeof now !== 'function' || typeof sleep !== 'function'
      || typeof random !== 'function'
      || !Number.isSafeInteger(intervalMs) || intervalMs < 1000
      || !Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < intervalMs) {
      throw new TypeError('Invalid cell settings poller');
    }
    Object.assign(this, { sync, intervalMs, maxBackoffMs, onStatus, now, sleep, random });
    this.running = null;
    this.controller = null;
    this.status = Object.freeze({ state: 'idle', lastSuccessAt: null,
      lastAttemptAt: null, consecutiveFailures: 0 });
  }

  report(update) {
    this.status = Object.freeze({ ...this.status, ...update });
    try { this.onStatus(this.status); } catch { /* status display must not stop VPN sync */ }
  }

  start() {
    if (this.running) throw new Error('Cell settings poller already running');
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.running = Promise.resolve().then(() => this.loop(signal)).finally(() => {
      this.running = null; this.controller = null;
      this.report({ state: 'stopped' });
    });
    return this.running;
  }

  async loop(signal) {
    let failures = 0;
    while (!signal.aborted) {
      const attemptAt = this.now();
      this.report({ state: 'polling', lastAttemptAt: attemptAt });
      if (signal.aborted) break;
      try {
        await this.sync({ signal });
        failures = 0;
        this.report({ state: 'connected', lastSuccessAt: this.now(),
          consecutiveFailures: 0 });
      } catch {
        failures++;
        this.report({ state: 'degraded', consecutiveFailures: failures });
      }
      if (signal.aborted) break;
      const delay = failures === 0 ? this.intervalMs
        : Math.min(this.maxBackoffMs, this.intervalMs * 2 ** Math.min(failures - 1, 30));
      const sample = this.random();
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
        throw new Error('Invalid settings poll jitter source');
      }
      await this.sleep(Math.max(1000, Math.min(this.maxBackoffMs,
        Math.round(delay * (0.75 + 0.5 * sample)))), signal);
    }
  }

  async stop() {
    if (!this.running) return;
    this.controller.abort();
    await this.running;
  }
}

module.exports = { CellSettingsPoller };
