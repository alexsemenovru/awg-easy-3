'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { SOURCE, SOURCE_URL, MAX_DOWNLOAD, releaseMonth, databaseUrl, downloadDatabase } = require('./GeoIpSource');
const { parseInWorker } = require('./GeoIpWorker');

const DAY = 86400000;
const MAGIC = 'AWG-Easy-3 GeoIP v1';

// The envelope and compressed source are a single atomic file: there is no
// window in which metadata points to a different month's data after a crash.
const packSnapshot = (release, bytes) => Buffer.concat([
  Buffer.from(`${MAGIC}\n${release}\n${crypto.createHash('sha256').update(bytes).digest('hex')}\n`), bytes,
]);
const unpackSnapshot = (buffer) => {
  if (buffer.length > MAX_DOWNLOAD + 128) throw new Error('GeoIP snapshot is too large');
  const header = buffer.subarray(0, 128).toString('ascii').split('\n');
  if (header[0] !== MAGIC || !/^[a-f0-9]{64}$/.test(header[2] ?? '')) throw new Error('Invalid GeoIP snapshot');
  databaseUrl(header[1]);
  const bytes = buffer.subarray(Buffer.byteLength(`${header[0]}\n${header[1]}\n${header[2]}\n`));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== header[2]) throw new Error('GeoIP snapshot checksum mismatch');
  return { release: header[1], bytes };
};

class GeoIpUpdater {
  constructor({ directory, fileSystem = fs, download = downloadDatabase, parse = parseInWorker,
    install = async (snapshot, commit) => commit(), now = () => new Date(), random = Math.random,
    setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {} } = {}) {
    this.directory = path.resolve(directory);
    this.filename = path.join(this.directory, 'current.db');
    this.fs = fileSystem;
    this.download = download;
    this.parse = parse;
    this.install = install;
    this.now = now;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onError = onError;
    this.current = null;
    this.running = false;
    this.pending = null;
    this.failures = 0;
    this.timer = null;
    this.controller = null;
    this.status = { source: SOURCE, sourceUrl: SOURCE_URL, state: 'unavailable', release: null, checkedAt: null };
  }

  async load() {
    try {
      const handle = await this.fs.open(this.filename, 'r');
      let buffer;
      try {
        if ((await handle.stat()).size > MAX_DOWNLOAD + 128) throw new Error('GeoIP snapshot is too large');
        buffer = await handle.readFile();
      } finally { await handle.close(); }
      const { release, bytes } = unpackSnapshot(buffer);
      const parsed = await this.parse(bytes);
      this.current = { ...parsed, release };
      this.status = { ...this.status, state: 'ready', release };
    } catch (error) {
      if (error.code !== 'ENOENT') this.onError(error);
      this.status = { ...this.status, state: 'unavailable' };
    }
    return this.current;
  }

  async persist(release, bytes) {
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.candidate-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await this.fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(packSnapshot(release, bytes)); await handle.sync(); }
      finally { await handle.close(); }
      await this.fs.rename(temporary, this.filename);
    } finally {
      await this.fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') this.onError(error); });
    }
  }

  refresh() {
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.pending = (async () => {
      try {
        const date = this.now();
        let release = releaseMonth(date);
        this.status = { ...this.status, checkedAt: date.toISOString() };
        // Monthly immutable releases: a daily check does not download the same
        // archive repeatedly, nor replace a newer local snapshot after clock drift.
        if (this.current && this.current.release >= release) {
          this.failures = 0;
          this.status = { ...this.status, state: 'ready' };
          return this.current;
        }
        this.status = { ...this.status, state: 'updating' };
        let bytes;
        try { bytes = await this.download(release, { signal }); }
        catch (error) {
          if (error.status !== 404 || this.current || signal.aborted) throw error;
          // At the start of a month the new edition may not have been published.
          release = releaseMonth(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
          bytes = await this.download(release, { signal });
        }
        const parsed = await this.parse(bytes, { signal });
        if (signal.aborted) throw new Error('GeoIP update cancelled');
        const snapshot = { ...parsed, release };
        let committed = false;
        await this.install(snapshot, async () => {
          if (signal.aborted) throw new Error('GeoIP update cancelled');
          await this.persist(release, bytes);
          committed = true;
          this.current = snapshot;
        });
        if (!committed) throw new Error('GeoIP installer did not commit the snapshot');
        this.failures = 0;
        this.status = { ...this.status, state: 'ready', release };
        return this.current;
      } catch (error) {
        this.failures += 1;
        this.status = { ...this.status, state: this.current ? 'stale' : 'unavailable' };
        if (!signal.aborted) this.onError(error);
        return this.current;
      }
    })().finally(() => { this.pending = null; this.controller = null; });
    return this.pending;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      this.timer = null;
      await this.refresh();
      if (!this.running) return;
      const base = this.failures ? Math.min(DAY, 300000 * (2 ** Math.min(this.failures - 1, 8))) : DAY;
      this.timer = this.setTimer(tick, Math.round(base * (1 + this.random() * 0.2)));
      this.timer?.unref?.();
    };
    // No network wait on the panel's startup path.
    this.timer = this.setTimer(tick, 1000 + Math.round(this.random() * 29000));
    this.timer?.unref?.();
  }

  async stop() {
    this.running = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.pending;
  }
}

module.exports = { GeoIpUpdater, packSnapshot, unpackSnapshot };
