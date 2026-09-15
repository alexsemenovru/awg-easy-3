'use strict';

// Controller loss never changes routes or removes the last applied configuration.
// No host services are installed by this class. Exactly one sync is in flight.
class CellAgent {
  constructor({ restore, sync, intervalMs = 15000, maxBackoffMs = 60000,
    schedule = setTimeout, cancel = clearTimeout, onStatus = () => {} }) {
    if (typeof restore !== 'function' || typeof sync !== 'function'
      || !Number.isSafeInteger(intervalMs) || intervalMs < 100
      || !Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < intervalMs) {
      throw new TypeError('Invalid cell agent configuration');
    }
    Object.assign(this, { restore, sync, intervalMs, maxBackoffMs, schedule, cancel, onStatus });
    this.running = false;
    this.pending = null;
    this.timer = null;
    this.delay = intervalMs;
    this.status = Object.freeze({ state: 'stopped', lastConfirmedAt: null });
  }

  report(change) {
    this.status = Object.freeze({ ...this.status, ...change });
    // UI/diagnostic callbacks must not break the control loop.
    try { this.onStatus(this.status); } catch {}
  }

  async start() {
    if (this.running || this.pending) throw new Error('Cell agent already started');
    this.running = true;
    this.report({ state: 'restoring' });
    const startup = Promise.resolve().then(() => this.restore());
    this.pending = startup;
    try { await startup; }
    catch (error) {
      this.running = false;
      this.report({ state: 'restore-failed' });
      throw error;
    } finally { if (this.pending === startup) this.pending = null; }
    if (this.running) await this.tick();
  }

  async tick() {
    if (!this.running || this.pending) return;
    const job = Promise.resolve().then(() => this.sync());
    this.pending = job;
    try {
      const result = await job;
      this.delay = this.intervalMs;
      if (this.running) this.report({ state: 'connected', lastConfirmedAt: Date.now(),
        revision: result.revision ?? null });
    } catch {
      if (this.running) this.report({ state: 'sync-failed' });
      this.delay = Math.min(this.maxBackoffMs, this.delay * 2);
    } finally {
      if (this.pending === job) this.pending = null;
      if (this.running) {
        this.timer = this.schedule(() => { this.timer = null; void this.tick(); }, this.delay);
        this.timer?.unref?.();
      }
    }
  }

  async stop() {
    this.running = false;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    await this.pending?.catch(() => {});
    this.report({ state: 'stopped' });
    // Deliberately no VPN teardown: administrative uninstall is separate.
  }
}

module.exports = { CellAgent };
